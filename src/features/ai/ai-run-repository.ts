import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { aiProposals, aiRuns, type NewAiProposalRecord, type NewAiRunRecord } from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";

type AiRunDatabase = typeof db;

type CreateAiRunInput = Pick<
  NewAiRunRecord,
  "documentId" | "promptTemplateId" | "commandType" | "provider" | "model" | "inputSummaryJson"
>;

export type ClaimAiRunInput = CreateAiRunInput &
  Pick<NewAiRunRecord, "idempotencyKey" | "operationFingerprint"> & {
    idempotencyKey: string;
    operationFingerprint: string;
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
  >;

function requireExecutionToken<T extends { executionToken: string | null }>(run: T): T & { executionToken: string } {
  if (!run.executionToken) throw new Error("Claimed AI run is missing its execution token");
  return run as T & { executionToken: string };
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
    return { proposals, run };
  }

  function classifyClaim(
    durable: Awaited<ReturnType<typeof getAiRunByIdempotencyKey>>,
    operationFingerprint: string,
  ) {
    if (!durable) return null;
    if (durable.run.operationFingerprint !== operationFingerprint) {
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
      const now = new Date();
      const executionToken = crypto.randomUUID();
      const [inserted] = await database
        .insert(aiRuns)
        .values({
          ...input,
          workspaceId: scope.workspaceId,
          outputText: "",
          retryNotBeforeAt: null,
          status: "pending",
          wasApplied: false,
          errorMessage: null,
          executionToken,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [aiRuns.workspaceId, aiRuns.idempotencyKey] })
        .returning();
      if (inserted) return { kind: "claimed" as const, run: requireExecutionToken(inserted) };

      const existing = await getAiRunByIdempotencyKey(scope, input.idempotencyKey);
      const classified = classifyClaim(existing, input.operationFingerprint);
      if (classified) return classified;
      if (!existing) throw new Error("AI run claim could not be observed");
      if (existing.run.status !== "failed") return { kind: "in_progress" as const, run: existing.run };

      const retryExecutionToken = crypto.randomUUID();
      const [retried] = await database
        .update(aiRuns)
        .set({
          commandType: input.commandType,
          documentId: input.documentId,
          errorMessage: null,
          executionToken: retryExecutionToken,
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
          eq(aiRuns.id, existing.run.id),
          eq(aiRuns.operationFingerprint, input.operationFingerprint),
          or(isNull(aiRuns.retryNotBeforeAt), lte(aiRuns.retryNotBeforeAt, now)),
          eq(aiRuns.status, "failed"),
        ))
        .returning();
      if (retried) return { kind: "claimed" as const, run: requireExecutionToken(retried) };

      const raced = await getAiRunByIdempotencyKey(scope, input.idempotencyKey);
      return classifyClaim(raced, input.operationFingerprint) ?? {
        kind: "in_progress" as const,
        run: raced?.run ?? existing.run,
      };
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
        const [run] = await transaction
          .update(aiRuns)
          .set({
            outputText,
            retryNotBeforeAt: null,
            executionToken: null,
            status: "completed",
            errorMessage: null,
            updatedAt: now,
          })
          .where(and(
            eq(aiRuns.workspaceId, scope.workspaceId),
            eq(aiRuns.id, id),
            eq(aiRuns.executionToken, executionToken),
            inArray(aiRuns.status, ["pending", "streaming"]),
          ))
          .returning();

        if (!run) {
          return null;
        }

        if (proposals.length === 0) {
          return { run, proposals: [] };
        }

        const savedProposals = await transaction
          .insert(aiProposals)
          .values(
            proposals.map((proposal, resultOrdinal) => ({
              ...proposal,
              aiRunId: id,
              resultOrdinal,
              workspaceId: scope.workspaceId,
              status: "pending" as const,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .returning();

        if (savedProposals.some((proposal) => proposal.resultOrdinal === null)) {
          throw new Error("Finalized AI proposals require a durable result order");
        }
        savedProposals.sort((left, right) => left.resultOrdinal! - right.resultOrdinal!);

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
        .orderBy(desc(aiRuns.createdAt));
    },

    getAiRunByIdempotencyKey,
  };
}

const defaultRepository = createAiRunRepository();

export const createAiRun = defaultRepository.createAiRun;
export const claimAiRun = defaultRepository.claimAiRun;
export const completeAiRun = defaultRepository.completeAiRun;
export const completeAiRunWithProposals = defaultRepository.completeAiRunWithProposals;
export const failAiRun = defaultRepository.failAiRun;
export const getAiRunByIdempotencyKey = defaultRepository.getAiRunByIdempotencyKey;
export const listAiRunsForDocument = defaultRepository.listAiRunsForDocument;
