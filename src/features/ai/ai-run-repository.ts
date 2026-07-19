import { and, asc, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { retrySqliteContention } from "@/db/sqlite-contention";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  aiProposals,
  aiRuns,
  collaborationAiRunSnapshots,
  collaborationDocuments,
  collaborationProposalAnchors,
  type NewAiProposalRecord,
  type NewAiRunRecord,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { decodeCollectionCursor, encodeCollectionCursor } from "@/features/pagination/collection-cursor";
import { AiRunCollaborationFenceError } from "./ai-collaboration-fence";

type AiRunDatabase = typeof db;
type AiRunTransaction = Parameters<Parameters<AiRunDatabase["transaction"]>[0]>[0];

type CreateAiRunInput = Pick<
  NewAiRunRecord,
  "documentId" | "promptTemplateId" | "commandType" | "provider" | "model" | "inputSummaryJson"
>;

export type ClaimAiRunInput = CreateAiRunInput &
  Pick<NewAiRunRecord, "idempotencyKey" | "operationFingerprint"> & {
    idempotencyKey: string;
    operationFingerprint: string;
    collaborationSnapshot?: Pick<
      typeof collaborationAiRunSnapshots.$inferInsert,
      "contentHash" | "documentId" | "generation" | "headSeq" | "schemaFingerprint"
    > & { stateVector: Uint8Array };
  };

type FinalizeAiRunProposalAnchor = Pick<
  typeof collaborationProposalAnchors.$inferInsert,
  | "baseHeadSeq"
  | "endAssoc"
  | "generation"
  | "schemaFingerprint"
  | "startAssoc"
  | "targetHash"
  | "targetPreview"
> & {
  baseStateVector: Uint8Array;
  endRelative: Uint8Array;
  startRelative: Uint8Array;
};

type FinalizeAiRunProposalInput = Pick<
  NewAiProposalRecord,
  "documentId" | "targetText" | "replacementText" | "explanation"
> &
  Partial<
    Pick<
      NewAiProposalRecord,
      "source" | "command" | "occurrenceIndex" | "targetFrom" | "targetTo" | "defaultApplyMode"
    >
  > & { anchor?: FinalizeAiRunProposalAnchor };

function requireExecutionToken<T extends { executionToken: string | null }>(run: T): T & { executionToken: string } {
  if (!run.executionToken) throw new Error("Claimed AI run is missing its execution token");
  return run as T & { executionToken: string };
}

async function insertInitialAiRunClaim(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  input: ClaimAiRunInput,
  executionToken: string,
  timestamp: Date,
) {
  const { collaborationSnapshot, ...runInput } = input;
  const [run] = await transaction
    .insert(aiRuns)
    .values({
      ...runInput,
      workspaceId: scope.workspaceId,
      outputText: "",
      retryNotBeforeAt: null,
      status: "pending",
      wasApplied: false,
      errorMessage: null,
      executionToken,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing({ target: [aiRuns.workspaceId, aiRuns.idempotencyKey] })
    .returning();
  if (!run) return null;
  if (collaborationSnapshot) {
    await transaction.insert(collaborationAiRunSnapshots).values({
      ...collaborationSnapshot,
      aiRunId: run.id,
      createdAt: timestamp,
      stateVector: Buffer.from(collaborationSnapshot.stateVector),
      workspaceId: scope.workspaceId,
    });
  } else {
    await assertLegacyDocumentNotInitialized(transaction, scope, input.documentId);
  }
  return run;
}

async function retryFailedAiRunInTransaction(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  input: ClaimAiRunInput,
  existingRunId: string,
  executionToken: string,
  retryEligibleAt: Date,
) {
  if (!input.collaborationSnapshot) {
    await assertLegacyDocumentNotInitialized(transaction, scope, input.documentId);
  }
  const [run] = await transaction
    .update(aiRuns)
    .set({
      commandType: input.commandType,
      documentId: input.documentId,
      errorMessage: null,
      executionToken,
      inputSummaryJson: input.inputSummaryJson,
      model: input.model,
      outputText: "",
      promptTemplateId: input.promptTemplateId,
      provider: input.provider,
      retryNotBeforeAt: null,
      status: "pending",
      updatedAt: new Date(),
    })
    .where(and(
      eq(aiRuns.workspaceId, scope.workspaceId),
      eq(aiRuns.id, existingRunId),
      eq(aiRuns.operationFingerprint, input.operationFingerprint),
      or(isNull(aiRuns.retryNotBeforeAt), lte(aiRuns.retryNotBeforeAt, retryEligibleAt)),
      eq(aiRuns.status, "failed"),
    ))
    .returning();
  return run ?? null;
}

async function loadAiRunFinalizationContext(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  runId: string,
  executionToken: string,
  proposals: FinalizeAiRunProposalInput[],
) {
  const [eligible] = await transaction
    .select({ documentId: aiRuns.documentId, id: aiRuns.id })
    .from(aiRuns)
    .where(and(
      eq(aiRuns.workspaceId, scope.workspaceId),
      eq(aiRuns.id, runId),
      eq(aiRuns.executionToken, executionToken),
      inArray(aiRuns.status, ["pending", "streaming"]),
    ))
    .limit(1);
  if (!eligible) return null;
  const [collaborationSnapshot] = await transaction
    .select()
    .from(collaborationAiRunSnapshots)
    .where(and(
      eq(collaborationAiRunSnapshots.workspaceId, scope.workspaceId),
      eq(collaborationAiRunSnapshots.aiRunId, runId),
    ))
    .limit(1);
  if (!collaborationSnapshot) {
    await assertLegacyDocumentNotInitialized(transaction, scope, eligible.documentId);
  }
  assertProposalAnchorContract(collaborationSnapshot ?? null, proposals);
  return {
    collaborationSnapshot: collaborationSnapshot ?? null,
    documentId: eligible.documentId,
  };
}

async function markAiRunCompletedInTransaction(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  runId: string,
  executionToken: string,
  outputText: string,
  timestamp: Date,
) {
  const [run] = await transaction
    .update(aiRuns)
    .set({
      outputText,
      retryNotBeforeAt: null,
      executionToken: null,
      status: "completed",
      errorMessage: null,
      updatedAt: timestamp,
    })
    .where(and(
      eq(aiRuns.workspaceId, scope.workspaceId),
      eq(aiRuns.id, runId),
      eq(aiRuns.executionToken, executionToken),
      inArray(aiRuns.status, ["pending", "streaming"]),
    ))
    .returning();
  return run ?? null;
}

async function insertFinalizedProposalsWithAnchors(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  runId: string,
  proposals: FinalizeAiRunProposalInput[],
  collaborationSnapshot: typeof collaborationAiRunSnapshots.$inferSelect | null,
  timestamp: Date,
) {
  if (proposals.length === 0) return [];

  const savedProposals = await transaction
    .insert(aiProposals)
    .values(
      proposals.map((proposalWithAnchor, resultOrdinal) => {
        const proposal = { ...proposalWithAnchor };
        delete proposal.anchor;
        return {
          id: crypto.randomUUID(),
          ...proposal,
          aiRunId: runId,
          resultOrdinal,
          workspaceId: scope.workspaceId,
          status: "pending" as const,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }),
    )
    .returning();

  if (savedProposals.some((proposal) => proposal.resultOrdinal === null)) {
    throw new Error("Finalized AI proposals require a durable result order");
  }
  savedProposals.sort((left, right) => left.resultOrdinal! - right.resultOrdinal!);

  if (collaborationSnapshot) {
    await transaction.insert(collaborationProposalAnchors).values(
      savedProposals.map((savedProposal, resultOrdinal) => {
        const anchor = proposals[resultOrdinal]!.anchor!;
        return {
          ...anchor,
          baseStateVector: Buffer.from(anchor.baseStateVector),
          createdAt: timestamp,
          documentId: savedProposal.documentId,
          endRelative: Buffer.from(anchor.endRelative),
          proposalId: savedProposal.id,
          startRelative: Buffer.from(anchor.startRelative),
          workspaceId: scope.workspaceId,
        };
      }),
    );
  }

  return savedProposals;
}

export function createAiRunRepository(database: AiRunDatabase = db) {
  async function getAiRunByIdempotencyKey(scope: WorkspaceScope, idempotencyKey: string) {
    const [run] = await database
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.workspaceId, scope.workspaceId), eq(aiRuns.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!run) return null;
    const proposals = await database
      .select()
      .from(aiProposals)
      .where(and(eq(aiProposals.workspaceId, scope.workspaceId), eq(aiProposals.aiRunId, run.id)))
      .orderBy(asc(aiProposals.resultOrdinal), asc(aiProposals.id));
    const [collaborationSnapshot] = await database
      .select()
      .from(collaborationAiRunSnapshots)
      .where(and(
        eq(collaborationAiRunSnapshots.workspaceId, scope.workspaceId),
        eq(collaborationAiRunSnapshots.aiRunId, run.id),
      ))
      .limit(2);
    const proposalAnchors = proposals.length === 0
      ? []
      : await database
        .select()
        .from(collaborationProposalAnchors)
        .where(and(
          eq(collaborationProposalAnchors.workspaceId, scope.workspaceId),
          inArray(collaborationProposalAnchors.proposalId, proposals.map(({ id }) => id)),
        ));
    if (
      (collaborationSnapshot && proposalAnchors.length !== proposals.length)
      || (!collaborationSnapshot && proposalAnchors.length > 0)
    ) {
      throw new Error("Stored collaborative AI result is corrupt");
    }
    proposalAnchors.sort((left, right) => {
      const leftOrdinal = proposals.find(({ id }) => id === left.proposalId)?.resultOrdinal ?? -1;
      const rightOrdinal = proposals.find(({ id }) => id === right.proposalId)?.resultOrdinal ?? -1;
      return leftOrdinal - rightOrdinal;
    });
    return {
      collaborationSnapshot: collaborationSnapshot ?? null,
      proposalAnchors,
      proposals,
      run,
    };
  }

  function classifyClaim(
    durable: Awaited<ReturnType<typeof getAiRunByIdempotencyKey>>,
    input: ClaimAiRunInput,
  ) {
    if (!durable) return null;
    if (
      durable.run.operationFingerprint !== input.operationFingerprint
      || !sameSnapshotIdentity(durable.collaborationSnapshot, input.collaborationSnapshot)
    ) {
      return { kind: "conflict" as const };
    }
    if (durable.run.status === "completed") {
      return { kind: "completed" as const, ...durable };
    }
    if (durable.run.status === "pending" || durable.run.status === "streaming") {
      return { kind: "in_progress" as const, run: durable.run };
    }
    if (
      durable.run.status === "failed" &&
      durable.run.retryNotBeforeAt &&
      durable.run.retryNotBeforeAt.getTime() > Date.now()
    ) {
      return { kind: "in_progress" as const, run: durable.run };
    }
    return null;
  }

  return {
    async claimAiRun(scope: WorkspaceScope, input: ClaimAiRunInput) {
      return withSerializedDocumentWrite(scope, `ai-run:${input.idempotencyKey}`, async () => {
        const now = new Date();
        const executionToken = crypto.randomUUID();
        const inserted = await retrySqliteContention(() => database.transaction((transaction) =>
          insertInitialAiRunClaim(transaction, scope, input, executionToken, now)));
        if (inserted) return { kind: "claimed" as const, run: requireExecutionToken(inserted) };

        const existing = await getAiRunByIdempotencyKey(scope, input.idempotencyKey);
        const classified = classifyClaim(existing, input);
        if (classified) return classified;
        if (!existing) throw new Error("AI run claim could not be observed");
        if (existing.run.status !== "failed") return { kind: "in_progress" as const, run: existing.run };

        const retryExecutionToken = crypto.randomUUID();
        const retried = await retrySqliteContention(() => database.transaction((transaction) =>
          retryFailedAiRunInTransaction(
            transaction,
            scope,
            input,
            existing.run.id,
            retryExecutionToken,
            now,
          )));
        if (retried) return { kind: "claimed" as const, run: requireExecutionToken(retried) };

        const raced = await getAiRunByIdempotencyKey(scope, input.idempotencyKey);
        return classifyClaim(raced, input) ?? {
          kind: "in_progress" as const,
          run: raced?.run ?? existing.run,
        };
      });
    },

    async createAiRun(scope: WorkspaceScope, input: CreateAiRunInput) {
      const now = new Date();
      const [run] = await database
        .insert(aiRuns)
        .values({
          ...input,
          workspaceId: scope.workspaceId,
          outputText: "",
          retryNotBeforeAt: null,
          status: "pending",
          wasApplied: false,
          errorMessage: null,
          executionToken: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return run!;
    },

    async completeAiRun(scope: WorkspaceScope, id: string, executionToken: string, outputText: string) {
      const [run] = await database
        .update(aiRuns)
        .set({
          outputText,
          retryNotBeforeAt: null,
          executionToken: null,
          status: "completed",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(aiRuns.workspaceId, scope.workspaceId),
          eq(aiRuns.id, id),
          eq(aiRuns.executionToken, executionToken),
          inArray(aiRuns.status, ["pending", "streaming"]),
        ))
        .returning();

      return run ?? null;
    },

    async completeAiRunWithProposals(
      scope: WorkspaceScope,
      id: string,
      executionToken: string,
      outputText: string,
      proposals: FinalizeAiRunProposalInput[],
    ) {
      return database.transaction(async (transaction) => {
        const now = new Date();
        const context = await loadAiRunFinalizationContext(
          transaction,
          scope,
          id,
          executionToken,
          proposals,
        );
        if (!context) return null;
        const run = await markAiRunCompletedInTransaction(
          transaction,
          scope,
          id,
          executionToken,
          outputText,
          now,
        );
        if (!run) return null;
        const savedProposals = await insertFinalizedProposalsWithAnchors(
          transaction,
          scope,
          id,
          proposals,
          context.collaborationSnapshot,
          now,
        );
        return { run, proposals: savedProposals };
      });
    },

    async failAiRun(
      scope: WorkspaceScope,
      id: string,
      executionToken: string,
      errorMessage: string,
      options?: { retryNotBeforeAt?: Date | null },
    ) {
      const [run] = await database
        .update(aiRuns)
        .set({
          status: "failed",
          errorMessage,
          executionToken: null,
          retryNotBeforeAt: options?.retryNotBeforeAt ?? null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(aiRuns.workspaceId, scope.workspaceId),
          eq(aiRuns.id, id),
          eq(aiRuns.executionToken, executionToken),
          inArray(aiRuns.status, ["pending", "streaming"]),
        ))
        .returning();

      return run ?? null;
    },

    async listAiRunsForDocument(scope: WorkspaceScope, documentId: string) {
      return database
        .select()
        .from(aiRuns)
        .where(and(eq(aiRuns.workspaceId, scope.workspaceId), eq(aiRuns.documentId, documentId)))
        .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
        .limit(50);
    },

    async listAiRunSummariesPage(
      scope: WorkspaceScope,
      documentId: string,
      input: { cursor?: string; limit?: number } = {},
    ) {
      const limit = normalizePageLimit(input.limit);
      const cursorScope = {
        collection: "ai-runs",
        documentId,
        workspaceId: scope.workspaceId,
      } as const;
      const cursor = input.cursor ? decodeCollectionCursor(input.cursor, cursorScope) : null;
      const rows = await database
        .select({
          commandType: aiRuns.commandType,
          createdAt: aiRuns.createdAt,
          id: aiRuns.id,
          status: aiRuns.status,
        })
        .from(aiRuns)
        .where(and(
          eq(aiRuns.workspaceId, scope.workspaceId),
          eq(aiRuns.documentId, documentId),
          cursor
            ? or(
                lt(aiRuns.createdAt, cursor.timestamp),
                and(eq(aiRuns.createdAt, cursor.timestamp), lt(aiRuns.id, cursor.id)),
              )
            : undefined,
        ))
        .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit && items.length > 0
          ? encodeCollectionCursor({ id: items.at(-1)!.id, timestamp: items.at(-1)!.createdAt }, cursorScope)
          : null,
      };
    },

    getAiRunByIdempotencyKey,
  };
}

function sameSnapshotIdentity(
  durable: typeof collaborationAiRunSnapshots.$inferSelect | null,
  requested: ClaimAiRunInput["collaborationSnapshot"],
) {
  if (!durable || !requested) return !durable && !requested;
  return durable.documentId === requested.documentId
    && durable.generation === requested.generation
    && durable.headSeq === requested.headSeq
    && durable.schemaFingerprint === requested.schemaFingerprint
    && durable.contentHash === requested.contentHash
    && Buffer.from(durable.stateVector).equals(Buffer.from(requested.stateVector));
}

async function assertLegacyDocumentNotInitialized(
  transaction: AiRunTransaction,
  scope: WorkspaceScope,
  documentId: string,
) {
  const [initialized] = await transaction
    .select({ generation: collaborationDocuments.generation })
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, documentId),
      eq(collaborationDocuments.isCurrent, true),
    ))
    .limit(1);
  if (initialized) throw new AiRunCollaborationFenceError();
}

function assertProposalAnchorContract(
  snapshot: typeof collaborationAiRunSnapshots.$inferSelect | null,
  proposals: FinalizeAiRunProposalInput[],
) {
  if (!snapshot) {
    if (proposals.some(({ anchor }) => anchor !== undefined)) {
      throw new Error("Legacy AI proposals cannot contain collaboration anchors");
    }
    return;
  }
  for (const proposal of proposals) {
    const anchor = proposal.anchor;
    if (!anchor) throw new Error("Collaborative AI proposals require an anchor");
    if (
      proposal.documentId !== snapshot.documentId
      || anchor.generation !== snapshot.generation
      || anchor.baseHeadSeq !== snapshot.headSeq
      || anchor.schemaFingerprint !== snapshot.schemaFingerprint
      || !Buffer.from(anchor.baseStateVector).equals(Buffer.from(snapshot.stateVector))
    ) {
      throw new Error("Collaborative AI proposal anchor does not match its run snapshot");
    }
  }
}

function normalizePageLimit(value: number | undefined) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(value ?? 20, 50)) : 20;
}

const defaultRepository = createAiRunRepository();

export const createAiRun = defaultRepository.createAiRun;
export const claimAiRun = defaultRepository.claimAiRun;
export const completeAiRun = defaultRepository.completeAiRun;
export const completeAiRunWithProposals = defaultRepository.completeAiRunWithProposals;
export const failAiRun = defaultRepository.failAiRun;
export const getAiRunByIdempotencyKey = defaultRepository.getAiRunByIdempotencyKey;
export const listAiRunsForDocument = defaultRepository.listAiRunsForDocument;
export const listAiRunSummariesPage = defaultRepository.listAiRunSummariesPage;
