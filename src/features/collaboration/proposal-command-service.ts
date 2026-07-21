import { createHash } from "node:crypto";

import { and, eq, inArray, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as Y from "yjs";

import { db } from "@/db/client";
import {
  aiProposals,
  collaborationActions,
  collaborationDocumentChanges,
  collaborationDocuments,
  collaborationProposalAnchors,
  documentChangeProposals,
  documentChanges,
  documents,
  type AiProposalRecord,
  type DocumentChangeRecord,
  type DocumentRecord,
} from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createDocumentWorkflowNotificationOutbox } from "@/features/documents/document-workflow-notification-outbox";
import { emitCollaborationCommandConflict } from "@/features/observability/telemetry";
import type { ProposalApplyMode } from "@/features/proposals/proposal-transaction";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";

import { hashCanonicalJson } from "./canonical-hashing";
import { createCollaborationCommandDeliveryOutbox } from "./command-delivery-outbox";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type CollaborationPersistence,
  type CollaborationSnapshot,
} from "./persistence";
import {
  applyCollaborativeProposalBatch,
  type CollaborativeProposalAnchor,
  type CollaborativeProposalCommandItem,
} from "./proposal-command";
import type { CollaborationDatabase, CollaborationTransaction } from "./repository";
import { captureCollaborativeInverse, type StoredCollaborativeInverse } from "./selective-undo";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export type CollaborativeProposalApplyInput = {
  commandId: string;
  items: Array<{ mode: ProposalApplyMode; proposalId: string }>;
  observedHeadSeq: number;
};

export type CollaborativeProposalApplyResult =
  | {
      change: DocumentChangeRecord;
      collaboration: { generation: number; headSeq: number };
      document: DocumentRecord;
      ok: true;
      proposals: AiProposalRecord[];
      replayed: boolean;
    }
  | {
      ok: false;
      reason:
        | "idempotency_conflict"
        | "invalid_request"
        | "not_found"
        | "proposal_overlap_conflict"
        | "proposal_status_conflict"
        | "proposal_target_conflict"
        | "unavailable";
    };

type ProposalPlan = {
  actionType: "proposal_apply" | "proposal_batch_apply";
  afterMaterialization: ReturnType<ReturnType<typeof createCollaborationDocumentCodec>["materialize"]>;
  baseHeadSeq: number;
  beforeMaterialization: ReturnType<ReturnType<typeof createCollaborationDocumentCodec>["materialize"]>;
  beforeReadiness: DocumentRecord["readiness"];
  commandFingerprint: string;
  items: Array<{ mode: ProposalApplyMode; proposal: AiProposalRecord }>;
  /** Null only when the command was a canonical Yjs no-op. */
  storedInverse: StoredCollaborativeInverse | null;
};

class CollaborativeProposalRollback extends Error {
  constructor(readonly reason: Exclude<CollaborativeProposalApplyResult, { ok: true }>["reason"]) {
    super("Collaborative Proposal command rolled back");
  }
}

export function createCollaborativeProposalService(options: {
  database?: CollaborationDatabase;
  persistence?: CollaborationPersistence;
} = {}) {
  const database = options.database ?? db;
  const profile = resolveActiveProjectProfile();
  const codec = createCollaborationDocumentCodec(profile);
  const persistence = options.persistence ?? createCollaborationPersistence(database, {
    codec,
    projectProfile: profile,
  });
  const deliveryOutbox = createCollaborationCommandDeliveryOutbox({ database });
  const workflowOutbox = createDocumentWorkflowNotificationOutbox({ database });

  const service = {
    async apply(
      context: RequestContext,
      input: CollaborativeProposalApplyInput,
    ): Promise<CollaborativeProposalApplyResult> {
      if (!isValidInput(input)) return { ok: false, reason: "invalid_request" };
      const resolved = await resolveInitialCommand(database, context.workspaceId, input.items);
      if (!resolved.ok) return resolved;
      const actionType: ProposalPlan["actionType"] = input.items.length === 1
        ? "proposal_apply"
        : "proposal_batch_apply";
      const commandFingerprint = fingerprintCommand({
        actionType,
        anchorGeneration: resolved.generation,
        anchorSchemaFingerprint: resolved.schemaFingerprint,
        documentId: resolved.documentId,
        items: input.items,
      });
      let semanticFailure: Exclude<CollaborativeProposalApplyResult, { ok: true }>["reason"] | null = null;
      const expectedCommandIdentity = {
        actionType,
        commandFingerprint,
        commandId: input.commandId,
        documentId: resolved.documentId,
        generation: resolved.generation,
        principalId: context.principalId,
        proposalId: input.items.length === 1 ? input.items[0]!.proposalId : null,
        workspaceId: context.workspaceId,
      };

      let initialCommandIdentity: WorkspaceCommandIdentity;
      try {
        initialCommandIdentity = await classifyWorkspaceCommandIdentity(database, expectedCommandIdentity);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (initialCommandIdentity.kind === "conflict") {
        return { ok: false, reason: "idempotency_conflict" };
      }
      let actionId = initialCommandIdentity.kind === "exact"
        ? initialCommandIdentity.actionId
        : createActionId(context.workspaceId, resolved.documentId, input.commandId);

      const commitCommand = () => persistence.commitServerCommand(context, {
        diagnosticJson: {
          itemCount: input.items.length,
          observedHeadSeq: input.observedHeadSeq,
        },
        documentId: resolved.documentId,
        expectedGeneration: resolved.generation,
        idempotencyKey: input.commandId,
        originKind: "proposal_command" as const,
        principalId: context.principalId,
        requestId: context.requestId,
        semanticActionId: actionId,
      }, {
        async plan(transaction, snapshot) {
          const plan = await planProposalCommand({
            actionType,
            codec,
            commandFingerprint,
            documentId: resolved.documentId,
            input,
            snapshot,
            transaction,
            workspaceId: context.workspaceId,
          });
          if (!plan.ok) {
            semanticFailure = plan.reason;
            throw new CollaborationPersistenceError("invalid_input", false);
          }
          return { plan: plan.plan, update: plan.update };
        },

        async prepare(transaction, { plan, position, snapshot }) {
          await transaction.insert(collaborationActions).values({
            actionType: plan.actionType,
            appliedHeadSeq: null,
            baseHeadSeq: snapshot.headSeq,
            commandFingerprint: plan.commandFingerprint,
            commandId: input.commandId,
            createdAt: position.timestamp,
            documentChangeId: null,
            documentId: resolved.documentId,
            failureCategory: null,
            generation: position.generation,
            id: actionId,
            principalId: context.principalId,
            proposalId: input.items.length === 1 ? input.items[0]!.proposalId : null,
            requestId: context.requestId,
            status: "pending",
            updatedAt: position.timestamp,
            workspaceId: context.workspaceId,
          });
        },

        async commit(transaction, { plan, position, receipt }) {
          return commitProposalCommand({
            actionId,
            commandId: input.commandId,
            context,
            database,
            deliveryOutbox,
            documentId: resolved.documentId,
            plan,
            position,
            receipt,
            transaction,
            workflowOutbox,
          });
        },

        async replay(transaction, { receipt, snapshot, update }) {
          const replay = await replayProposalCommand({
            actionType,
            actionId,
            commandFingerprint,
            commandId: input.commandId,
            context,
            deliveryOutbox,
            documentId: resolved.documentId,
            receipt,
            snapshot,
            transaction,
            update,
          });
          if (!replay.ok) {
            semanticFailure = replay.reason;
            throw new CollaborationPersistenceError("idempotency_conflict", false);
          }
          return replay.result;
        },
      });

      try {
        const committed = await commitCommand();
        return { ...committed.result, ok: true, replayed: committed.replayed };
      } catch (initialError) {
        let error = initialError;
        let racedCommandIdentity: WorkspaceCommandIdentity = { kind: "missing" };
        try {
          racedCommandIdentity = await classifyWorkspaceCommandIdentity(database, expectedCommandIdentity);
        } catch {
          return { ok: false, reason: "unavailable" };
        }
        if (racedCommandIdentity.kind === "conflict") {
          return { ok: false, reason: "idempotency_conflict" };
        }
        if (racedCommandIdentity.kind === "exact" && initialCommandIdentity.kind === "missing") {
          actionId = racedCommandIdentity.actionId;
          try {
            const recovered = await commitCommand();
            return { ...recovered.result, ok: true, replayed: recovered.replayed };
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        if (semanticFailure) return { ok: false, reason: semanticFailure };
        if (
          error instanceof CollaborationPersistenceError
          && error.category === "stale_generation"
        ) {
          return { ok: false, reason: "proposal_target_conflict" };
        }
        if (
          error instanceof CollaborationPersistenceError
          && error.category === "idempotency_conflict"
        ) {
          return { ok: false, reason: "idempotency_conflict" };
        }
        if (error instanceof CollaborativeProposalRollback) {
          return { ok: false, reason: error.reason };
        }
        return { ok: false, reason: "unavailable" };
      }
    },
  };

  return {
    async apply(
      context: RequestContext,
      input: CollaborativeProposalApplyInput,
    ): Promise<CollaborativeProposalApplyResult> {
      return emitCollaborationCommandConflict(await service.apply(context, input));
    },
  };
}

type WorkspaceCommandIdentity =
  | { actionId: string; kind: "exact" }
  | { kind: "conflict" | "missing" };

async function classifyWorkspaceCommandIdentity(
  database: CollaborationDatabase,
  expected: {
    actionType: ProposalPlan["actionType"];
    commandFingerprint: string;
    commandId: string;
    documentId: string;
    generation: number;
    principalId: string;
    proposalId: string | null;
    workspaceId: string;
  },
): Promise<WorkspaceCommandIdentity> {
  const [action] = await database.select().from(collaborationActions).where(and(
    eq(collaborationActions.workspaceId, expected.workspaceId),
    eq(collaborationActions.commandId, expected.commandId),
  )).limit(1);
  if (!action) return { kind: "missing" };

  // requestId is transport correlation and may change on a network retry. The
  // canonical command fingerprint is the exact semantic request identity.
  const exact = action.documentId === expected.documentId
    && (action.generation === expected.generation || action.generation === expected.generation + 1)
    && action.actionType === expected.actionType
    && action.commandFingerprint === expected.commandFingerprint
    && action.principalId === expected.principalId
    && action.proposalId === expected.proposalId
    && action.status === "applied"
    && action.appliedHeadSeq !== null
    && action.documentChangeId !== null;
  return exact ? { actionId: action.id, kind: "exact" } : { kind: "conflict" };
}

async function planProposalCommand(options: {
  actionType: ProposalPlan["actionType"];
  codec: ReturnType<typeof createCollaborationDocumentCodec>;
  commandFingerprint: string;
  documentId: string;
  input: CollaborativeProposalApplyInput;
  snapshot: CollaborationSnapshot;
  transaction: CollaborationTransaction;
  workspaceId: string;
}): Promise<
  | {
      ok: false;
      reason:
        | "proposal_overlap_conflict"
        | "proposal_status_conflict"
        | "proposal_target_conflict"
        | "unavailable";
    }
  | { ok: true; plan: ProposalPlan; update: Uint8Array }
> {
  if (options.input.observedHeadSeq > options.snapshot.headSeq) {
    return { ok: false, reason: "proposal_target_conflict" };
  }
  const loaded = await loadProposalItems(
    options.transaction,
    options.workspaceId,
    options.documentId,
    options.input.items,
  );
  if (!loaded.ok) return loaded;
  const [documentRow] = await options.transaction.select().from(documents).where(and(
    eq(documents.workspaceId, options.workspaceId),
    eq(documents.id, options.documentId),
    eq(documents.status, "draft"),
  )).limit(1);
  if (!documentRow) return { ok: false, reason: "proposal_target_conflict" };

  const working = options.codec.loadCheckpoint(Y.encodeStateAsUpdate(options.snapshot.document));
  try {
    const beforeMaterialization = options.codec.materialize(working);
    const baseState = Y.encodeStateAsUpdate(working);
    const before = Y.encodeStateVector(working);
    const commandItems: CollaborativeProposalCommandItem[] = loaded.items.map(({ anchor, mode, proposal }) => ({
      anchor,
      mode,
      proposalId: proposal.id,
      replacementText: proposal.replacementText,
    }));
    const applied = applyCollaborativeProposalBatch(working, {
      generation: options.snapshot.generation,
      headSeq: options.snapshot.headSeq,
      schemaFingerprint: options.snapshot.schemaFingerprint,
      stateVector: Y.encodeStateVector(working),
    }, commandItems);
    if (!applied.ok) return applied;
    const update = Y.encodeStateAsUpdate(working, before);
    let storedInverse: StoredCollaborativeInverse | null = null;
    if (!isCanonicalNoopUpdate(update)) {
      const capture = captureCollaborativeInverse({
        baseState,
        changedRange: applied.changedRange,
        forwardUpdate: update,
      });
      if (!capture.ok) return { ok: false, reason: "unavailable" };
      storedInverse = capture.inverse;
    }
    return {
      ok: true,
      plan: {
        actionType: options.actionType,
        afterMaterialization: options.codec.materialize(working),
        baseHeadSeq: options.snapshot.headSeq,
        beforeMaterialization,
        beforeReadiness: documentRow.readiness,
        commandFingerprint: options.commandFingerprint,
        items: loaded.items.map(({ mode, proposal }) => ({ mode, proposal })),
        storedInverse,
      },
      update,
    };
  } finally {
    working.destroy();
  }
}

/** An update with no structs and an empty delete set encodes as `[0, 0]`. */
function isCanonicalNoopUpdate(update: Uint8Array) {
  return update.byteLength <= 2 && update.every((byte) => byte === 0);
}

async function commitProposalCommand(options: {
  actionId: string;
  commandId: string;
  context: RequestContext;
  database: CollaborationDatabase;
  deliveryOutbox: ReturnType<typeof createCollaborationCommandDeliveryOutbox>;
  documentId: string;
  plan: ProposalPlan;
  position: Parameters<CollaborationPersistence["commitServerCommand"]>[2] extends never ? never : {
    changed: boolean;
    generation: number;
    headSeq: number;
    revisionAdvanced: boolean;
    seq: number;
    timestamp: Date;
  };
  receipt: { checksum: string; generation: number; headSeq: number; workflowChanged: boolean };
  transaction: CollaborationTransaction;
  workflowOutbox: ReturnType<typeof createDocumentWorkflowNotificationOutbox>;
}) {
  const updatedProposals: AiProposalRecord[] = [];
  for (const { mode, proposal } of options.plan.items) {
    const [updated] = await options.transaction.update(aiProposals).set({
      appliedMode: mode,
      status: "accepted",
      updatedAt: options.position.timestamp,
    }).where(and(
      eq(aiProposals.workspaceId, options.context.workspaceId),
      eq(aiProposals.documentId, options.documentId),
      eq(aiProposals.id, proposal.id),
      eq(aiProposals.status, "pending"),
    )).returning();
    if (!updated) throw new CollaborativeProposalRollback("proposal_status_conflict");
    updatedProposals.push(updated);
  }

  const [currentDocument] = await options.transaction.select().from(documents).where(and(
    eq(documents.workspaceId, options.context.workspaceId),
    eq(documents.id, options.documentId),
    eq(documents.status, "draft"),
  )).limit(1);
  if (!currentDocument) throw new CollaborativeProposalRollback("not_found");
  if (options.position.changed) {
    const [projected] = await options.transaction.update(collaborationDocuments).set({
      projectedSeq: options.receipt.headSeq,
      updatedAt: options.position.timestamp,
    }).where(and(
      eq(collaborationDocuments.workspaceId, options.context.workspaceId),
      eq(collaborationDocuments.documentId, options.documentId),
      eq(collaborationDocuments.generation, options.receipt.generation),
      eq(collaborationDocuments.isCurrent, true),
      eq(collaborationDocuments.headSeq, options.receipt.headSeq),
      lte(collaborationDocuments.projectedSeq, options.receipt.headSeq),
    )).returning({ generation: collaborationDocuments.generation });
    if (!projected) throw new CollaborativeProposalRollback("unavailable");
  }
  const nextRevision = currentDocument.revision + (options.position.revisionAdvanced ? 0 : 1);
  const [updatedDocument] = await options.transaction.update(documents).set({
    contentJson: options.plan.afterMaterialization.contentJson,
    metadataJson: options.plan.afterMaterialization.metadataJson,
    plainText: options.plan.afterMaterialization.plainText,
    revision: nextRevision,
    title: options.plan.afterMaterialization.title,
    updatedAt: options.position.timestamp,
  }).where(and(
    eq(documents.workspaceId, options.context.workspaceId),
    eq(documents.id, options.documentId),
    eq(documents.status, "draft"),
    eq(documents.revision, currentDocument.revision),
  )).returning();
  if (!updatedDocument) throw new CollaborativeProposalRollback("unavailable");

  const changeId = nanoid();
  const [change] = await options.transaction.insert(documentChanges).values({
    afterRevision: updatedDocument.revision,
    batchId: options.plan.items.length > 1 ? nanoid() : null,
    beforeSnapshotJson: {
      ...options.plan.beforeMaterialization,
      readiness: options.plan.beforeReadiness,
    },
    createdAt: options.position.timestamp,
    documentId: options.documentId,
    id: changeId,
    kind: options.plan.items.length > 1 ? "batch" : "single",
    principalId: options.context.principalId,
    requestId: options.context.requestId,
    workspaceId: options.context.workspaceId,
  }).returning();
  if (!change) throw new CollaborativeProposalRollback("unavailable");
  await options.transaction.insert(documentChangeProposals).values(
    options.plan.items.map(({ mode, proposal }, ordinal) => ({
      appliedMode: mode,
      changeId,
      documentId: options.documentId,
      ordinal,
      proposalId: proposal.id,
      workspaceId: options.context.workspaceId,
    })),
  );
  if (options.position.changed && options.plan.storedInverse) {
    await options.transaction.insert(collaborationDocumentChanges).values({
      actionId: options.actionId,
      affectedEndRelative: Buffer.from(options.plan.storedInverse.affectedRange.end),
      affectedStartRelative: Buffer.from(options.plan.storedInverse.affectedRange.start),
      baseHeadSeq: options.plan.baseHeadSeq,
      changeId,
      documentId: options.documentId,
      forwardSeq: options.position.seq,
      generation: options.position.generation,
      inverseUpdate: Buffer.from(options.plan.storedInverse.inverseUpdate),
      postconditionFingerprint: options.plan.storedInverse.postconditionFingerprint,
      resultingHeadSeq: options.receipt.headSeq,
      workspaceId: options.context.workspaceId,
    });
  }
  const [action] = await options.transaction.update(collaborationActions).set({
    appliedHeadSeq: options.receipt.headSeq,
    documentChangeId: changeId,
    status: "applied",
    updatedAt: options.position.timestamp,
  }).where(and(
    eq(collaborationActions.workspaceId, options.context.workspaceId),
    eq(collaborationActions.id, options.actionId),
    eq(collaborationActions.documentId, options.documentId),
    eq(collaborationActions.generation, options.position.generation),
    eq(collaborationActions.commandFingerprint, options.plan.commandFingerprint),
    eq(collaborationActions.status, "pending"),
  )).returning();
  if (!action) throw new CollaborativeProposalRollback("unavailable");

  if (options.position.changed) {
    await options.deliveryOutbox.enqueue(options.transaction, {
      actionId: action.id,
      checksum: options.receipt.checksum,
      commandFingerprint: options.plan.commandFingerprint,
      commandId: options.commandId,
      documentId: options.documentId,
      generation: options.position.generation,
      seq: options.position.seq,
      timestamp: options.position.timestamp,
      workspaceId: options.context.workspaceId,
    });
  }
  if (options.receipt.workflowChanged) {
    await options.workflowOutbox.enqueue(options.transaction, {
      documentId: options.documentId,
      generation: options.position.generation,
      timestamp: options.position.timestamp,
      workflowRevision: updatedDocument.revision,
      workspaceId: options.context.workspaceId,
    });
  }
  return {
    change,
    collaboration: { generation: options.receipt.generation, headSeq: options.receipt.headSeq },
    document: updatedDocument,
    proposals: updatedProposals,
  };
}

async function replayProposalCommand(options: {
  actionId: string;
  actionType: ProposalPlan["actionType"];
  commandFingerprint: string;
  commandId: string;
  context: RequestContext;
  deliveryOutbox: ReturnType<typeof createCollaborationCommandDeliveryOutbox>;
  documentId: string;
  receipt: { checksum: string; generation: number; headSeq: number; seq: number };
  snapshot: CollaborationSnapshot;
  transaction: CollaborationTransaction;
  update: Uint8Array | null;
}) {
  const [action] = await options.transaction.select().from(collaborationActions).where(and(
    eq(collaborationActions.workspaceId, options.context.workspaceId),
    eq(collaborationActions.commandId, options.commandId),
  )).limit(1);
  if (
    !action
    || action.id !== options.actionId
    || action.documentId !== options.documentId
    || action.actionType !== options.actionType
    || action.commandFingerprint !== options.commandFingerprint
    || action.principalId !== options.context.principalId
    || action.status !== "applied"
    || action.appliedHeadSeq !== options.receipt.headSeq
    || !action.documentChangeId
  ) {
    return { ok: false as const, reason: "idempotency_conflict" as const };
  }
  const [change] = await options.transaction.select().from(documentChanges).where(and(
    eq(documentChanges.workspaceId, options.context.workspaceId),
    eq(documentChanges.documentId, options.documentId),
    eq(documentChanges.id, action.documentChangeId),
  )).limit(1);
  const [document] = await options.transaction.select().from(documents).where(and(
    eq(documents.workspaceId, options.context.workspaceId),
    eq(documents.id, options.documentId),
  )).limit(1);
  const proposalLinks = await options.transaction.select().from(documentChangeProposals).where(and(
    eq(documentChangeProposals.workspaceId, options.context.workspaceId),
    eq(documentChangeProposals.changeId, action.documentChangeId),
  ));
  const proposals = proposalLinks.length === 0 ? [] : await options.transaction.select().from(aiProposals).where(and(
    eq(aiProposals.workspaceId, options.context.workspaceId),
    inArray(aiProposals.id, proposalLinks.map(({ proposalId }) => proposalId)),
  ));
  if (!change || !document || proposals.length !== proposalLinks.length) {
    return { ok: false as const, reason: "idempotency_conflict" as const };
  }
  if (options.update) {
    await options.deliveryOutbox.enqueue(options.transaction, {
      actionId: action.id,
      checksum: options.receipt.checksum,
      commandFingerprint: options.commandFingerprint,
      commandId: options.commandId,
      documentId: options.documentId,
      generation: options.receipt.generation,
      seq: options.receipt.seq,
      timestamp: new Date(),
      workspaceId: options.context.workspaceId,
    });
  }
  const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  return {
    ok: true as const,
    result: {
      change,
      collaboration: { generation: options.receipt.generation, headSeq: options.receipt.headSeq },
      document,
      proposals: proposalLinks
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ proposalId }) => proposalsById.get(proposalId)!),
    },
  };
}

async function resolveInitialCommand(
  database: CollaborationDatabase,
  workspaceId: string,
  items: CollaborativeProposalApplyInput["items"],
): Promise<
  | { documentId: string; generation: number; ok: true; schemaFingerprint: string }
  | { ok: false; reason: "not_found" | "proposal_target_conflict" }
> {
  const ids = items.map(({ proposalId }) => proposalId);
  const proposals = await database.select({ documentId: aiProposals.documentId, id: aiProposals.id })
    .from(aiProposals)
    .where(and(eq(aiProposals.workspaceId, workspaceId), inArray(aiProposals.id, ids)));
  if (proposals.length !== ids.length) return { ok: false, reason: "not_found" };
  const documentIds = new Set(proposals.map(({ documentId }) => documentId));
  if (documentIds.size !== 1) return { ok: false, reason: "proposal_target_conflict" };
  const anchors = await database.select({
    generation: collaborationProposalAnchors.generation,
    schemaFingerprint: collaborationProposalAnchors.schemaFingerprint,
  })
    .from(collaborationProposalAnchors)
    .where(and(
      eq(collaborationProposalAnchors.workspaceId, workspaceId),
      inArray(collaborationProposalAnchors.proposalId, ids),
    ));
  if (anchors.length !== ids.length) return { ok: false, reason: "proposal_target_conflict" };
  const generations = new Set(anchors.map(({ generation }) => generation));
  const schemas = new Set(anchors.map(({ schemaFingerprint }) => schemaFingerprint));
  if (generations.size !== 1 || schemas.size !== 1) {
    return { ok: false, reason: "proposal_target_conflict" };
  }
  return {
    documentId: proposals[0]!.documentId,
    generation: anchors[0]!.generation,
    ok: true,
    schemaFingerprint: anchors[0]!.schemaFingerprint,
  };
}

async function loadProposalItems(
  transaction: CollaborationTransaction,
  workspaceId: string,
  documentId: string,
  requests: CollaborativeProposalApplyInput["items"],
): Promise<
  | { items: Array<{ anchor: CollaborativeProposalAnchor; mode: ProposalApplyMode; proposal: AiProposalRecord }>; ok: true }
  | { ok: false; reason: "proposal_status_conflict" | "proposal_target_conflict" }
> {
  const ids = requests.map(({ proposalId }) => proposalId);
  const proposals = await transaction.select().from(aiProposals).where(and(
    eq(aiProposals.workspaceId, workspaceId),
    eq(aiProposals.documentId, documentId),
    inArray(aiProposals.id, ids),
  ));
  const anchors = await transaction.select().from(collaborationProposalAnchors).where(and(
    eq(collaborationProposalAnchors.workspaceId, workspaceId),
    eq(collaborationProposalAnchors.documentId, documentId),
    inArray(collaborationProposalAnchors.proposalId, ids),
  ));
  if (proposals.length !== ids.length || anchors.length !== ids.length) {
    return { ok: false, reason: "proposal_target_conflict" };
  }
  const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const anchorsById = new Map(anchors.map((anchor) => [anchor.proposalId, anchor]));
  const items = requests.map(({ mode, proposalId }) => {
    const proposal = proposalsById.get(proposalId)!;
    const stored = anchorsById.get(proposalId)!;
    return {
      anchor: {
        baseHeadSeq: stored.baseHeadSeq,
        baseStateVector: Uint8Array.from(stored.baseStateVector),
        endAssoc: stored.endAssoc as 1,
        endRelative: Uint8Array.from(stored.endRelative),
        generation: stored.generation,
        schemaFingerprint: stored.schemaFingerprint,
        startAssoc: stored.startAssoc as -1,
        startRelative: Uint8Array.from(stored.startRelative),
        targetHash: stored.targetHash,
        targetPreview: stored.targetPreview,
      },
      mode,
      proposal,
    };
  });
  if (items.some(({ proposal }) => proposal.status !== "pending")) {
    return { ok: false, reason: "proposal_status_conflict" };
  }
  if (items.some(({ anchor, proposal }) => sha256(proposal.targetText) !== anchor.targetHash)) {
    return { ok: false, reason: "proposal_target_conflict" };
  }
  return { items, ok: true };
}

function isValidInput(input: CollaborativeProposalApplyInput) {
  return COMMAND_ID_PATTERN.test(input.commandId)
    && Number.isSafeInteger(input.observedHeadSeq)
    && input.observedHeadSeq >= 0
    && input.items.length >= 1
    && input.items.length <= 100
    && new Set(input.items.map(({ proposalId }) => proposalId)).size === input.items.length
    && input.items.every(({ mode, proposalId }) =>
      (mode === "replace" || mode === "insert_below")
      && proposalId.length > 0
      && proposalId === proposalId.trim()
      && Buffer.byteLength(proposalId, "utf8") <= 256);
}

function fingerprintCommand(value: unknown) {
  return hashCanonicalJson(value);
}

function createActionId(workspaceId: string, documentId: string, commandId: string) {
  return fingerprintCommand({
    commandId,
    documentId,
    kind: "collaboration_proposal_action",
    workspaceId,
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const defaultService = createCollaborativeProposalService();

export const applyCollaborativeProposalCommand = defaultService.apply;
