import { getSchema } from "@tiptap/core";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { initProseMirrorDoc } from "y-prosemirror";
import * as Y from "yjs";

import { db } from "@/db/client";
import {
  COLLABORATION_STORAGE_LIMITS,
  aiProposals,
  collaborationActions,
  collaborationDocumentChanges,
  collaborationDocuments,
  documentChangeProposals,
  documentChanges,
  documents,
  type AiProposalRecord,
  type DocumentChangeRecord,
  type DocumentRecord,
} from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createDocumentWorkflowNotificationOutbox } from "@/features/documents/document-workflow-notification-outbox";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";
import {
  createServerSchemaExtensions,
  type DocumentSchemaProfile,
} from "@/plugins/document-schema-profile";

import { canonicalJson, hashCanonicalJson } from "./canonical-hashing";
import { createCollaborationCommandDeliveryOutbox } from "./command-delivery-outbox";
import { COLLABORATION_BODY_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type CollaborationPersistence,
  type CollaborationSnapshot,
} from "./persistence";
import { COLLABORATION_PROPOSAL_COMMAND_ORIGIN } from "./proposal-command";
import {
  createCollaborationRelativePositionCodec,
  type EncodedRelativeRange,
} from "./relative-position";
import type { CollaborationDatabase, CollaborationTransaction } from "./repository";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const COLLABORATION_INVERSE_BASE_ORIGIN = "collaboration-selective-undo-base";
const COLLABORATION_INVERSE_APPLY_ORIGIN = "collaboration-selective-undo";

export type StoredCollaborativeInverse = {
  affectedRange: EncodedRelativeRange;
  inverseUpdate: Uint8Array;
  postconditionFingerprint: string;
};

export type CollaborativeInverseCapture =
  | { inverse: StoredCollaborativeInverse; ok: true }
  | { ok: false; reason: "inverse_capture_failed" };

export type CollaborativeUndoTargetResolution =
  | { from: number; ok: true; to: number }
  | { ok: false; reason: "undo_conflict" };

export type CollaborativeInverseCodec = {
  /**
   * Replays the exact forward command on a shadow document behind a
   * command-origin `Y.UndoManager`, then captures the inverse update, the
   * relative affected range, and the postcondition fingerprint of the command
   * result. Fails closed unless undoing the shadow restores the exact
   * pre-command body.
   */
  capture(input: {
    baseState: Uint8Array;
    changedRange: { from: number; to: number };
    forwardUpdate: Uint8Array;
  }): CollaborativeInverseCapture;
  /**
   * Verifies the stored postcondition against the live document, then appends
   * the inverse as a regular Yjs update. Never rewinds unrelated edits.
   */
  planUndo(
    document: Y.Doc,
    inverse: StoredCollaborativeInverse,
  ): CollaborativeUndoTargetResolution;
  verifyTarget(
    document: Y.Doc,
    inverse: Pick<StoredCollaborativeInverse, "affectedRange" | "postconditionFingerprint">,
  ): CollaborativeUndoTargetResolution;
};

export function createCollaborativeInverseCodec(
  schemaProfile: DocumentSchemaProfile = appDocumentSchemaProfileRuntime,
): CollaborativeInverseCodec {
  const schema = getSchema(createServerSchemaExtensions(schemaProfile));
  const positions = createCollaborationRelativePositionCodec(schemaProfile);

  const verifyTarget: CollaborativeInverseCodec["verifyTarget"] = (document, inverse) => {
    const resolved = positions.resolveEncodedRelativeRange(document, inverse.affectedRange);
    if (!resolved.ok) return undoConflict();
    const fingerprint = fingerprintBodyRange(document, resolved, schema);
    if (fingerprint === null || fingerprint !== inverse.postconditionFingerprint) {
      return undoConflict();
    }
    return { from: resolved.from, ok: true, to: resolved.to };
  };

  return {
    capture(input) {
      const shadow = new Y.Doc();
      const baseline = new Y.Doc();
      try {
        Y.applyUpdate(shadow, input.baseState, COLLABORATION_INVERSE_BASE_ORIGIN);
        Y.applyUpdate(baseline, input.baseState, COLLABORATION_INVERSE_BASE_ORIGIN);
        const body = shadow.getXmlFragment(COLLABORATION_BODY_NAME);
        const undoManager = new Y.UndoManager(body, {
          captureTimeout: 0,
          trackedOrigins: new Set([COLLABORATION_PROPOSAL_COMMAND_ORIGIN]),
        });
        try {
          Y.applyUpdate(shadow, input.forwardUpdate, COLLABORATION_PROPOSAL_COMMAND_ORIGIN);
          if (undoManager.undoStack.length === 0) return captureFailed();
          const afterForward = Y.encodeStateVector(shadow);
          const postconditionFingerprint = fingerprintBodyRange(shadow, input.changedRange, schema);
          if (postconditionFingerprint === null) return captureFailed();
          const affectedRange = positions.createEncodedRelativeRange(shadow, input.changedRange);
          undoManager.undo();
          const inverseUpdate = Y.encodeStateAsUpdate(shadow, afterForward);
          const restoredExactly = canonicalJson(bodyJson(shadow, schema))
            === canonicalJson(bodyJson(baseline, schema));
          if (
            !restoredExactly
            || inverseUpdate.byteLength < 1
            || inverseUpdate.byteLength > COLLABORATION_STORAGE_LIMITS.codecBytes
            || affectedRange.start.byteLength > COLLABORATION_STORAGE_LIMITS.relativePositionBytes
            || affectedRange.end.byteLength > COLLABORATION_STORAGE_LIMITS.relativePositionBytes
          ) {
            return captureFailed();
          }
          return {
            inverse: { affectedRange, inverseUpdate, postconditionFingerprint },
            ok: true,
          };
        } finally {
          undoManager.destroy();
        }
      } catch {
        return captureFailed();
      } finally {
        shadow.destroy();
        baseline.destroy();
      }
    },

    planUndo(document, inverse) {
      const verified = verifyTarget(document, inverse);
      if (!verified.ok) return verified;
      try {
        Y.applyUpdate(document, inverse.inverseUpdate, COLLABORATION_INVERSE_APPLY_ORIGIN);
      } catch {
        return undoConflict();
      }
      return verified;
    },

    verifyTarget,
  };
}

const defaultInverseCodec = createCollaborativeInverseCodec();

export function captureCollaborativeInverse(
  input: Parameters<CollaborativeInverseCodec["capture"]>[0],
): CollaborativeInverseCapture {
  return defaultInverseCodec.capture(input);
}

export function verifyCollaborativeUndoTarget(
  document: Y.Doc,
  inverse: Pick<StoredCollaborativeInverse, "affectedRange" | "postconditionFingerprint">,
): CollaborativeUndoTargetResolution {
  return defaultInverseCodec.verifyTarget(document, inverse);
}

export type CollaborativeUndoInput = {
  changeId: string;
  commandId: string;
  observedHeadSeq: number;
};

export type CollaborativeUndoResult =
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
        | "unavailable"
        | "undo_conflict";
    };

type UndoFailureReason = Exclude<CollaborativeUndoResult, { ok: true }>["reason"];

type UndoPlan = {
  afterMaterialization: ReturnType<ReturnType<typeof createCollaborationDocumentCodec>["materialize"]>;
  commandFingerprint: string;
  links: Array<typeof documentChangeProposals.$inferSelect>;
};

class CollaborativeUndoRollback extends Error {
  constructor(readonly reason: UndoFailureReason) {
    super("Collaborative selective undo rolled back");
  }
}

export function createCollaborativeSelectiveUndoService(options: {
  database?: CollaborationDatabase;
  persistence?: CollaborationPersistence;
} = {}) {
  const database = options.database ?? db;
  const profile = resolveActiveProjectProfile();
  const codec = createCollaborationDocumentCodec(profile);
  const inverseCodec = createCollaborativeInverseCodec();
  const persistence = options.persistence ?? createCollaborationPersistence(database, {
    codec,
    projectProfile: profile,
  });
  const deliveryOutbox = createCollaborationCommandDeliveryOutbox({ database });
  const workflowOutbox = createDocumentWorkflowNotificationOutbox({ database });

  return {
    async undo(
      context: RequestContext,
      input: CollaborativeUndoInput,
    ): Promise<CollaborativeUndoResult> {
      if (!isValidInput(input)) return { ok: false, reason: "invalid_request" };
      const resolved = await resolveUndoTarget(database, context.workspaceId, input.changeId);
      if (!resolved.ok) return resolved;
      const commandFingerprint = hashCanonicalJson({
        actionType: "selective_undo",
        changeId: input.changeId,
        documentId: resolved.documentId,
        forwardSeq: resolved.forwardSeq,
        sourceGeneration: resolved.sourceGeneration,
      });
      let semanticFailure: UndoFailureReason | null = null;
      const expectedCommandIdentity = {
        changeId: input.changeId,
        commandFingerprint,
        commandId: input.commandId,
        documentId: resolved.documentId,
        generation: resolved.currentGeneration,
        principalId: context.principalId,
        workspaceId: context.workspaceId,
      };

      let initialCommandIdentity: UndoCommandIdentity;
      try {
        initialCommandIdentity = await classifyUndoCommandIdentity(database, expectedCommandIdentity);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (initialCommandIdentity.kind === "conflict") {
        return { ok: false, reason: "idempotency_conflict" };
      }
      let actionId = initialCommandIdentity.kind === "exact"
        ? initialCommandIdentity.actionId
        : createUndoActionId(context.workspaceId, resolved.documentId, input.changeId, input.commandId);

      const commitCommand = () => persistence.commitServerCommand(context, {
        diagnosticJson: {
          changeId: input.changeId,
          observedHeadSeq: input.observedHeadSeq,
        },
        documentId: resolved.documentId,
        expectedGeneration: resolved.currentGeneration,
        idempotencyKey: input.commandId,
        originKind: "undo_command" as const,
        principalId: context.principalId,
        requestId: context.requestId,
        semanticActionId: actionId,
      }, {
        async plan(transaction, snapshot) {
          const plan = await planUndoCommand({
            codec,
            commandFingerprint,
            documentId: resolved.documentId,
            input,
            inverseCodec,
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
            actionType: "selective_undo",
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
            proposalId: null,
            requestId: context.requestId,
            status: "pending",
            updatedAt: position.timestamp,
            workspaceId: context.workspaceId,
          });
        },

        async commit(transaction, { plan, position, receipt }) {
          return commitUndoCommand({
            actionId,
            changeId: input.changeId,
            commandId: input.commandId,
            context,
            deliveryOutbox,
            documentId: resolved.documentId,
            plan,
            position,
            receipt,
            transaction,
            workflowOutbox,
          });
        },

        async replay(transaction, { receipt, update }) {
          const replay = await replayUndoCommand({
            actionId,
            changeId: input.changeId,
            commandFingerprint,
            commandId: input.commandId,
            context,
            deliveryOutbox,
            documentId: resolved.documentId,
            receipt,
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
        let racedCommandIdentity: UndoCommandIdentity = { kind: "missing" };
        try {
          racedCommandIdentity = await classifyUndoCommandIdentity(database, expectedCommandIdentity);
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
          return { ok: false, reason: "undo_conflict" };
        }
        if (
          error instanceof CollaborationPersistenceError
          && error.category === "idempotency_conflict"
        ) {
          return { ok: false, reason: "idempotency_conflict" };
        }
        if (error instanceof CollaborativeUndoRollback) {
          return { ok: false, reason: error.reason };
        }
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}

type UndoCommandIdentity =
  | { actionId: string; kind: "exact" }
  | { kind: "conflict" | "missing" };

async function classifyUndoCommandIdentity(
  database: CollaborationDatabase,
  expected: {
    changeId: string;
    commandFingerprint: string;
    commandId: string;
    documentId: string;
    generation: number;
    principalId: string;
    workspaceId: string;
  },
): Promise<UndoCommandIdentity> {
  const [action] = await database.select().from(collaborationActions).where(and(
    eq(collaborationActions.workspaceId, expected.workspaceId),
    eq(collaborationActions.commandId, expected.commandId),
  )).limit(1);
  if (!action) return { kind: "missing" };

  const exact = action.documentId === expected.documentId
    && (action.generation === expected.generation || action.generation === expected.generation + 1)
    && action.actionType === "selective_undo"
    && action.commandFingerprint === expected.commandFingerprint
    && action.principalId === expected.principalId
    && action.proposalId === null
    && action.documentChangeId === expected.changeId
    && action.status === "applied"
    && action.appliedHeadSeq !== null;
  return exact ? { actionId: action.id, kind: "exact" } : { kind: "conflict" };
}

async function resolveUndoTarget(
  database: CollaborationDatabase,
  workspaceId: string,
  changeId: string,
): Promise<
  | {
      currentGeneration: number;
      documentId: string;
      forwardSeq: number;
      ok: true;
      sourceGeneration: number;
    }
  | { ok: false; reason: "not_found" | "undo_conflict" }
> {
  const [change] = await database.select({
    documentId: documentChanges.documentId,
    id: documentChanges.id,
  }).from(documentChanges).where(and(
    eq(documentChanges.workspaceId, workspaceId),
    eq(documentChanges.id, changeId),
  )).limit(1);
  if (!change) return { ok: false, reason: "not_found" };
  const [stored] = await database.select({
    documentId: collaborationDocumentChanges.documentId,
    forwardSeq: collaborationDocumentChanges.forwardSeq,
    generation: collaborationDocumentChanges.generation,
  }).from(collaborationDocumentChanges).where(and(
    eq(collaborationDocumentChanges.workspaceId, workspaceId),
    eq(collaborationDocumentChanges.changeId, changeId),
  )).limit(1);
  if (!stored || stored.documentId !== change.documentId) {
    return { ok: false, reason: "undo_conflict" };
  }
  const [current] = await database.select({ generation: collaborationDocuments.generation })
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, workspaceId),
      eq(collaborationDocuments.documentId, change.documentId),
      eq(collaborationDocuments.isCurrent, true),
    )).limit(1);
  if (!current) return { ok: false, reason: "undo_conflict" };
  return {
    currentGeneration: current.generation,
    documentId: change.documentId,
    forwardSeq: stored.forwardSeq,
    ok: true,
    sourceGeneration: stored.generation,
  };
}

async function planUndoCommand(options: {
  codec: ReturnType<typeof createCollaborationDocumentCodec>;
  commandFingerprint: string;
  documentId: string;
  input: CollaborativeUndoInput;
  inverseCodec: CollaborativeInverseCodec;
  snapshot: CollaborationSnapshot;
  transaction: CollaborationTransaction;
  workspaceId: string;
}): Promise<
  | { ok: false; reason: "not_found" | "undo_conflict" }
  | { ok: true; plan: UndoPlan; update: Uint8Array }
> {
  if (options.input.observedHeadSeq > options.snapshot.headSeq) {
    return { ok: false, reason: "undo_conflict" };
  }
  const [change] = await options.transaction.select().from(documentChanges).where(and(
    eq(documentChanges.workspaceId, options.workspaceId),
    eq(documentChanges.id, options.input.changeId),
    eq(documentChanges.documentId, options.documentId),
  )).limit(1);
  if (!change || change.undoneAt !== null) return { ok: false, reason: "undo_conflict" };
  const [stored] = await options.transaction.select().from(collaborationDocumentChanges).where(and(
    eq(collaborationDocumentChanges.workspaceId, options.workspaceId),
    eq(collaborationDocumentChanges.changeId, options.input.changeId),
    eq(collaborationDocumentChanges.documentId, options.documentId),
  )).limit(1);
  if (!stored) return { ok: false, reason: "undo_conflict" };
  const [documentRow] = await options.transaction.select({ id: documents.id }).from(documents).where(and(
    eq(documents.workspaceId, options.workspaceId),
    eq(documents.id, options.documentId),
    eq(documents.status, "draft"),
  )).limit(1);
  if (!documentRow) return { ok: false, reason: "not_found" };
  const links = await options.transaction.select().from(documentChangeProposals).where(and(
    eq(documentChangeProposals.workspaceId, options.workspaceId),
    eq(documentChangeProposals.changeId, options.input.changeId),
    eq(documentChangeProposals.documentId, options.documentId),
  ));
  if (links.length === 0) return { ok: false, reason: "undo_conflict" };

  const working = options.codec.loadCheckpoint(Y.encodeStateAsUpdate(options.snapshot.document));
  try {
    const before = Y.encodeStateVector(working);
    const planned = options.inverseCodec.planUndo(working, {
      affectedRange: {
        end: Uint8Array.from(stored.affectedEndRelative),
        endAssoc: 1,
        start: Uint8Array.from(stored.affectedStartRelative),
        startAssoc: -1,
      },
      inverseUpdate: Uint8Array.from(stored.inverseUpdate),
      postconditionFingerprint: stored.postconditionFingerprint,
    });
    if (!planned.ok) return { ok: false, reason: "undo_conflict" };
    const update = Y.encodeStateAsUpdate(working, before);
    if (update.byteLength < 1) return { ok: false, reason: "undo_conflict" };
    return {
      ok: true,
      plan: {
        afterMaterialization: options.codec.materialize(working),
        commandFingerprint: options.commandFingerprint,
        links: [...links].sort((left, right) => left.ordinal - right.ordinal),
      },
      update,
    };
  } finally {
    working.destroy();
  }
}

async function commitUndoCommand(options: {
  actionId: string;
  changeId: string;
  commandId: string;
  context: RequestContext;
  deliveryOutbox: ReturnType<typeof createCollaborationCommandDeliveryOutbox>;
  documentId: string;
  plan: UndoPlan;
  position: {
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
  const resetProposals: AiProposalRecord[] = [];
  for (const link of options.plan.links) {
    const [reset] = await options.transaction.update(aiProposals).set({
      appliedMode: null,
      status: "pending",
      updatedAt: options.position.timestamp,
    }).where(and(
      eq(aiProposals.workspaceId, options.context.workspaceId),
      eq(aiProposals.documentId, options.documentId),
      eq(aiProposals.id, link.proposalId),
      eq(aiProposals.status, "accepted"),
      eq(aiProposals.appliedMode, link.appliedMode),
    )).returning();
    if (!reset) throw new CollaborativeUndoRollback("undo_conflict");
    resetProposals.push(reset);
  }

  const [currentDocument] = await options.transaction.select().from(documents).where(and(
    eq(documents.workspaceId, options.context.workspaceId),
    eq(documents.id, options.documentId),
    eq(documents.status, "draft"),
  )).limit(1);
  if (!currentDocument) throw new CollaborativeUndoRollback("not_found");
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
    if (!projected) throw new CollaborativeUndoRollback("unavailable");
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
  if (!updatedDocument) throw new CollaborativeUndoRollback("unavailable");

  const [undoneChange] = await options.transaction.update(documentChanges).set({
    undoneAt: options.position.timestamp,
  }).where(and(
    eq(documentChanges.workspaceId, options.context.workspaceId),
    eq(documentChanges.id, options.changeId),
    eq(documentChanges.documentId, options.documentId),
    isNull(documentChanges.undoneAt),
  )).returning();
  if (!undoneChange) throw new CollaborativeUndoRollback("undo_conflict");

  const [action] = await options.transaction.update(collaborationActions).set({
    appliedHeadSeq: options.receipt.headSeq,
    documentChangeId: options.changeId,
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
  if (!action) throw new CollaborativeUndoRollback("unavailable");

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
    change: undoneChange,
    collaboration: { generation: options.receipt.generation, headSeq: options.receipt.headSeq },
    document: updatedDocument,
    proposals: resetProposals,
  };
}

async function replayUndoCommand(options: {
  actionId: string;
  changeId: string;
  commandFingerprint: string;
  commandId: string;
  context: RequestContext;
  deliveryOutbox: ReturnType<typeof createCollaborationCommandDeliveryOutbox>;
  documentId: string;
  receipt: { checksum: string; generation: number; headSeq: number; seq: number };
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
    || action.actionType !== "selective_undo"
    || action.commandFingerprint !== options.commandFingerprint
    || action.principalId !== options.context.principalId
    || action.status !== "applied"
    || action.appliedHeadSeq !== options.receipt.headSeq
    || action.documentChangeId !== options.changeId
  ) {
    return { ok: false as const, reason: "idempotency_conflict" as const };
  }
  const [change] = await options.transaction.select().from(documentChanges).where(and(
    eq(documentChanges.workspaceId, options.context.workspaceId),
    eq(documentChanges.documentId, options.documentId),
    eq(documentChanges.id, options.changeId),
  )).limit(1);
  const [document] = await options.transaction.select().from(documents).where(and(
    eq(documents.workspaceId, options.context.workspaceId),
    eq(documents.id, options.documentId),
  )).limit(1);
  const links = await options.transaction.select().from(documentChangeProposals).where(and(
    eq(documentChangeProposals.workspaceId, options.context.workspaceId),
    eq(documentChangeProposals.changeId, options.changeId),
  ));
  const proposals = links.length === 0 ? [] : await options.transaction.select().from(aiProposals).where(and(
    eq(aiProposals.workspaceId, options.context.workspaceId),
    inArray(aiProposals.id, links.map(({ proposalId }) => proposalId)),
  ));
  if (!change || change.undoneAt === null || !document || proposals.length !== links.length) {
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
      proposals: [...links]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ proposalId }) => proposalsById.get(proposalId)!),
    },
  };
}

function fingerprintBodyRange(
  document: Y.Doc,
  range: { from: number; to: number },
  schema: ReturnType<typeof getSchema>,
): string | null {
  const existing = document.share.get(COLLABORATION_BODY_NAME);
  if (existing && !(existing instanceof Y.XmlFragment)) return null;
  let body: Y.XmlFragment;
  try {
    body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  } catch {
    return null;
  }
  let prosemirrorDocument;
  try {
    prosemirrorDocument = initProseMirrorDoc(body, schema).doc;
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(range.from)
    || !Number.isSafeInteger(range.to)
    || range.from < 0
    || range.to < range.from
    || range.to > prosemirrorDocument.content.size
  ) {
    return null;
  }
  const slice = prosemirrorDocument.slice(range.from, range.to);
  return hashCanonicalJson({
    content: slice.content.toJSON() ?? null,
    openEnd: slice.openEnd,
    openStart: slice.openStart,
  });
}

function bodyJson(document: Y.Doc, schema: ReturnType<typeof getSchema>) {
  const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  return initProseMirrorDoc(body, schema).doc.toJSON() as unknown;
}

function isValidInput(input: CollaborativeUndoInput) {
  return COMMAND_ID_PATTERN.test(input.commandId)
    && typeof input.changeId === "string"
    && input.changeId.length > 0
    && input.changeId === input.changeId.trim()
    && Buffer.byteLength(input.changeId, "utf8") <= 256
    && Number.isSafeInteger(input.observedHeadSeq)
    && input.observedHeadSeq >= 0;
}

function createUndoActionId(
  workspaceId: string,
  documentId: string,
  changeId: string,
  commandId: string,
) {
  return hashCanonicalJson({
    changeId,
    commandId,
    documentId,
    kind: "collaboration_selective_undo_action",
    workspaceId,
  });
}

function captureFailed(): CollaborativeInverseCapture {
  return { ok: false, reason: "inverse_capture_failed" };
}

function undoConflict(): { ok: false; reason: "undo_conflict" } {
  return { ok: false, reason: "undo_conflict" };
}

const defaultService = createCollaborativeSelectiveUndoService();

export const undoCollaborativeDocumentChange = defaultService.undo;
