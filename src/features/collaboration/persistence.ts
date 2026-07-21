import { createHash } from "node:crypto";

import { and, asc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import * as Y from "yjs";

import {
  COLLABORATION_STORAGE_LIMITS,
  aiProposals,
  collaborationAuthorizationEpochs,
  collaborationDocuments,
  collaborationNoopReceipts,
  collaborationUpdates,
  documentApprovals,
  documents,
  type CollaborationUpdateOriginKind,
} from "@/db/schema";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import { isRetryableSqliteContention } from "@/db/sqlite-contention";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import type { ProjectProfile } from "@/features/projects/project-profile";

import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  type CollaborationDocumentCodec,
  type CollaborationMaterialization,
} from "./contracts";
import { CollaborationCodecError, createCollaborationDocumentCodec } from "./document-codec";
import {
  AppendCandidateEvaluationError,
  evaluateAppendCandidate,
  shouldRotateAppend,
} from "./persistence-candidate";
import {
  createCollaborationRepository,
  type CollaborationDatabase,
  type CollaborationTransaction,
} from "./repository";

const DEFAULT_CUMULATIVE_UPDATE_BYTES = 12 * 1024 * 1024;

export type CollaborationSnapshot = {
  checkpointSeq: number;
  document: Y.Doc;
  documentId: string;
  generation: number;
  headSeq: number;
  projectedSeq: number;
  schemaFingerprint: string;
  schemaVersion: number;
};

export type AppendCollaborationUpdate = {
  diagnosticJson?: Record<string, unknown>;
  documentId: string;
  generation: number;
  idempotencyKey: string;
  originKind: CollaborationUpdateOriginKind;
  principalId: string;
  requestId?: string;
  semanticActionId?: string;
  sessionId?: string;
  update: Uint8Array;
};

export type AppendAuthorizedClientUpdate = AppendCollaborationUpdate & {
  authorizationEpoch: number;
  originKind: "client";
};

/**
 * Changed updates return their durable update-row sequence. A Yjs no-op stores
 * a durable receipt and returns its captured generation/head with
 * `seq === headSeq`, so exact retries remain stable as the document advances.
 */
export type DurableUpdateReceipt = {
  checksum: string;
  documentId: string;
  generation: number;
  headSeq: number;
  seq: number;
  /** True only when this append atomically changed server-owned workflow state. */
  workflowChanged: boolean;
};

export type DurableUpdateReplayIdentity = {
  documentId: string;
  idempotencyKey: string;
  originKind: CollaborationUpdateOriginKind;
  principalId: string;
  requestId?: string;
  semanticActionId?: string;
  sessionId?: string;
};

export type DurableUpdateReplay = {
  receipt: DurableUpdateReceipt;
  /** Null means the durable command was a canonical Yjs no-op. */
  update: Uint8Array | null;
};

export type ServerCommandAppendIdentity = Omit<
  AppendCollaborationUpdate,
  "generation" | "update"
> & {
  expectedGeneration: number;
};

export type ServerCommandAppendPosition = {
  changed: boolean;
  generation: number;
  headSeq: number;
  revisionAdvanced: boolean;
  seq: number;
  timestamp: Date;
};

export type CommitServerCommandResult<T> = {
  receipt: DurableUpdateReceipt;
  replayed: boolean;
  result: T;
  update: Uint8Array | null;
};

export type CheckpointReceipt = {
  checkpointSeq: number;
  checksum: string;
  documentId: string;
  generation: number;
  projectedSeq: number;
};

export type ProjectionReceipt = {
  documentId: string;
  generation: number;
  projectedSeq: number;
  revision: number;
};

export type CollaborationPersistenceCategory =
  | "authorization_revoked"
  | "checksum_mismatch"
  | "contention"
  | "corrupt_state"
  | "idempotency_conflict"
  | "internal"
  | "invalid_input"
  | "not_found"
  | "projection_fence"
  | "schema_mismatch"
  | "stale_generation"
  | "storage_budget";

const ERROR_MESSAGES: Record<CollaborationPersistenceCategory, string> = {
  authorization_revoked: "Collaboration authorization is no longer current",
  checksum_mismatch: "Collaboration state checksum validation failed",
  contention: "Collaboration persistence is temporarily busy",
  corrupt_state: "Collaboration state recovery failed",
  idempotency_conflict: "Collaboration idempotency identity conflicts with durable state",
  internal: "Collaboration persistence failed",
  invalid_input: "Collaboration persistence input is invalid",
  not_found: "Collaboration document was not found",
  projection_fence: "Collaboration projection sequence is outside the durable range",
  schema_mismatch: "Collaboration schema identity does not match the server",
  stale_generation: "Collaboration generation is no longer current",
  storage_budget: "Collaboration storage rotation cannot complete safely",
};

export class CollaborationPersistenceError extends Error {
  override readonly name = "CollaborationPersistenceError";

  constructor(
    readonly category: CollaborationPersistenceCategory,
    readonly retryable: boolean,
  ) {
    super(ERROR_MESSAGES[category]);
  }
}

export interface CollaborationPersistence {
  appendAuthorizedClientUpdate(
    scope: WorkspaceScope,
    input: AppendAuthorizedClientUpdate,
  ): Promise<DurableUpdateReceipt>;
  appendValidatedUpdate(
    scope: WorkspaceScope,
    input: AppendCollaborationUpdate,
  ): Promise<DurableUpdateReceipt>;
  checkpoint(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ): Promise<CheckpointReceipt>;
  commitServerCommand<TPlan, TResult>(
    scope: WorkspaceScope,
    input: ServerCommandAppendIdentity,
    operations: {
      commit(
        transaction: CollaborationTransaction,
        input: {
          plan: TPlan;
          position: ServerCommandAppendPosition;
          receipt: DurableUpdateReceipt;
          snapshot: CollaborationSnapshot;
        },
      ): Promise<TResult>;
      plan(
        transaction: CollaborationTransaction,
        snapshot: CollaborationSnapshot,
      ): Promise<{ plan: TPlan; update: Uint8Array }>;
      prepare(
        transaction: CollaborationTransaction,
        input: {
          plan: TPlan;
          position: ServerCommandAppendPosition;
          snapshot: CollaborationSnapshot;
        },
      ): Promise<void>;
      replay(
        transaction: CollaborationTransaction,
        input: {
          receipt: DurableUpdateReceipt;
          snapshot: CollaborationSnapshot;
          update: Uint8Array | null;
        },
      ): Promise<TResult>;
    },
  ): Promise<CommitServerCommandResult<TResult>>;
  findDurableUpdateReplay(
    scope: WorkspaceScope,
    identity: DurableUpdateReplayIdentity,
  ): Promise<DurableUpdateReplay | null>;
  initialize(scope: WorkspaceScope, documentId: string): Promise<CollaborationSnapshot>;
  load(scope: WorkspaceScope, documentId: string): Promise<CollaborationSnapshot | null>;
  project(
    scope: WorkspaceScope,
    documentId: string,
    throughSeq: number,
  ): Promise<ProjectionReceipt>;
  withInitializedWrite<T>(
    scope: WorkspaceScope,
    documentId: string,
    operation: (
      transaction: CollaborationTransaction,
      snapshot: CollaborationSnapshot,
    ) => Promise<T>,
  ): Promise<T>;
}

type CollaborationPersistenceOptions = {
  codec?: CollaborationDocumentCodec;
  now?: () => Date;
  projectProfile?: ProjectProfile;
  storageLimits?: {
    checkpointBytes?: number;
    cumulativeUpdateBytes?: number;
  };
};

type ServerCommandLifecycle<TPlan, TResult> = {
  commit(
    transaction: CollaborationTransaction,
    input: {
      plan: TPlan;
      position: ServerCommandAppendPosition;
      receipt: DurableUpdateReceipt;
      snapshot: CollaborationSnapshot;
    },
  ): Promise<TResult>;
  plan: TPlan;
  prepare(
    transaction: CollaborationTransaction,
    input: {
      plan: TPlan;
      position: ServerCommandAppendPosition;
      snapshot: CollaborationSnapshot;
    },
  ): Promise<void>;
};

type AppendInTransactionResult<TResult> = {
  receipt: DurableUpdateReceipt;
  result?: TResult;
  update: Uint8Array | null;
};

type AppendEvaluation = {
  evaluation: ReturnType<typeof evaluateAppendCandidate>;
  mustRotate: boolean;
  timestamp: Date;
};

type AppendPositionBasis = {
  appendGeneration: number;
  appendHeadSeq: number;
  projectedDuringRotation: boolean;
};

async function resolveAppendReplay<TResult>(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  updateChecksum: string,
): Promise<AppendInTransactionResult<TResult> | null> {
  const replay = await findIdempotentReceipt(transaction, scope, input);
  if (!replay) return null;
  if (!matchesIdempotentReceipt(replay, input, updateChecksum)) {
    throw persistenceError("idempotency_conflict", false);
  }
  return {
    receipt: durableReceipt(replay),
    update: replay.kind === "update" ? Uint8Array.from(replay.stored.updateBlob) : null,
  };
}

async function evaluateAppendInTransaction(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  loaded: CollaborationSnapshot,
  codec: CollaborationDocumentCodec,
  projectProfile: ProjectProfile,
  storageLimits: { checkpointBytes: number; cumulativeUpdateBytes: number },
  now: () => Date,
): Promise<AppendEvaluation> {
  const mustRotate = await planAppendStorage(
    transaction,
    scope,
    loaded,
    input.update.byteLength,
    storageLimits.cumulativeUpdateBytes,
  );
  const timestamp = now();
  try {
    return {
      evaluation: evaluateAppendCandidate({
        checkpointBytesLimit: storageLimits.checkpointBytes,
        codec,
        document: loaded.document,
        projectProfile,
        shouldMaterializeBeforeRotation: loaded.projectedSeq < loaded.headSeq,
        shouldRotate: mustRotate,
        update: input.update,
      }),
      mustRotate,
      timestamp,
    };
  } catch (error) {
    if (error instanceof AppendCandidateEvaluationError) {
      throw persistenceError(error.failure, error.failure === "storage_budget");
    }
    throw error;
  }
}

async function commitNoopAppend<TPlan, TResult>(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  loaded: CollaborationSnapshot,
  updateChecksum: string,
  timestamp: Date,
  lifecycle?: ServerCommandLifecycle<TPlan, TResult>,
): Promise<AppendInTransactionResult<TResult>> {
  const position: ServerCommandAppendPosition = {
    changed: false,
    generation: loaded.generation,
    headSeq: loaded.headSeq,
    revisionAdvanced: false,
    seq: loaded.headSeq,
    timestamp,
  };
  if (lifecycle) {
    await lifecycle.prepare(transaction, { plan: lifecycle.plan, position, snapshot: loaded });
  }
  await transaction.insert(collaborationNoopReceipts).values({
    checksum: updateChecksum,
    createdAt: timestamp,
    documentId: input.documentId,
    generation: loaded.generation,
    headSeq: loaded.headSeq,
    idempotencyKey: input.idempotencyKey,
    originKind: input.originKind,
    principalId: input.principalId,
    requestId: input.requestId,
    semanticActionId: input.semanticActionId,
    sessionId: input.sessionId,
    workspaceId: scope.workspaceId,
  });
  const receipt: DurableUpdateReceipt = {
    checksum: updateChecksum,
    documentId: input.documentId,
    generation: loaded.generation,
    headSeq: loaded.headSeq,
    seq: loaded.headSeq,
    workflowChanged: false,
  };
  const result = lifecycle
    ? await lifecycle.commit(transaction, {
        plan: lifecycle.plan,
        position,
        receipt,
        snapshot: loaded,
      })
    : undefined;
  return { receipt, result, update: null };
}

async function rotateAppendInTransaction(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  loaded: CollaborationSnapshot,
  evaluation: ReturnType<typeof evaluateAppendCandidate>,
  mustRotate: boolean,
  cumulativeUpdateBytes: number,
  timestamp: Date,
): Promise<AppendPositionBasis> {
  if (!mustRotate) {
    return {
      appendGeneration: loaded.generation,
      appendHeadSeq: loaded.headSeq,
      projectedDuringRotation: false,
    };
  }

  const rotation = evaluation.rotation;
  if (!rotation) throw persistenceError("corrupt_state", false);
  if (rotation.checkpoint.byteLength + input.update.byteLength > cumulativeUpdateBytes) {
    throw persistenceError("storage_budget", true);
  }
  let projectedDuringRotation = false;
  if (rotation.materialization) {
    await writeMaterializedDocument(
      transaction,
      scope,
      input.documentId,
      rotation.materialization,
      timestamp,
    );
    projectedDuringRotation = true;
  }
  const retired = await transaction
    .update(collaborationDocuments)
    .set({ isCurrent: false, projectedSeq: loaded.headSeq, updatedAt: timestamp })
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, input.documentId),
      eq(collaborationDocuments.generation, loaded.generation),
      eq(collaborationDocuments.isCurrent, true),
      eq(collaborationDocuments.headSeq, loaded.headSeq),
    ))
    .returning({ generation: collaborationDocuments.generation });
  if (!retired[0]) throw new CollaborationCasRetryError();
  const appendGeneration = loaded.generation + 1;
  await transaction.insert(collaborationDocuments).values({
    checkpointBlob: Buffer.from(rotation.checkpoint),
    checkpointChecksum: checksum(rotation.checkpoint),
    checkpointSeq: loaded.headSeq,
    createdAt: timestamp,
    documentId: input.documentId,
    generation: appendGeneration,
    headSeq: loaded.headSeq,
    isCurrent: true,
    lastCheckpointAt: timestamp,
    projectedSeq: loaded.headSeq,
    schemaFingerprint: loaded.schemaFingerprint,
    schemaVersion: loaded.schemaVersion,
    updatedAt: timestamp,
    workspaceId: scope.workspaceId,
  });
  return {
    appendGeneration,
    appendHeadSeq: loaded.headSeq,
    projectedDuringRotation,
  };
}

async function commitChangedAppend<TPlan, TResult>(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  loaded: CollaborationSnapshot,
  updateChecksum: string,
  timestamp: Date,
  positionBasis: AppendPositionBasis,
  lifecycle?: ServerCommandLifecycle<TPlan, TResult>,
): Promise<AppendInTransactionResult<TResult>> {
  const { appendGeneration, appendHeadSeq, projectedDuringRotation } = positionBasis;
  const seq = appendHeadSeq + 1;
  const advanced = await transaction
    .update(collaborationDocuments)
    .set({ headSeq: seq, updatedAt: timestamp })
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, input.documentId),
      eq(collaborationDocuments.generation, appendGeneration),
      eq(collaborationDocuments.isCurrent, true),
      eq(collaborationDocuments.headSeq, appendHeadSeq),
    ))
    .returning({ generation: collaborationDocuments.generation });
  if (!advanced[0]) throw new CollaborationCasRetryError();

  const position: ServerCommandAppendPosition = {
    changed: true,
    generation: appendGeneration,
    headSeq: seq,
    revisionAdvanced: projectedDuringRotation,
    seq,
    timestamp,
  };
  if (lifecycle) {
    await lifecycle.prepare(transaction, { plan: lifecycle.plan, position, snapshot: loaded });
  }
  await transaction.insert(collaborationUpdates).values({
    checksum: updateChecksum,
    createdAt: timestamp,
    diagnosticJson: input.diagnosticJson,
    documentId: input.documentId,
    generation: appendGeneration,
    idempotencyKey: input.idempotencyKey,
    originKind: input.originKind,
    principalId: input.principalId,
    requestId: input.requestId,
    semanticActionId: input.semanticActionId,
    seq,
    sessionId: input.sessionId,
    updateBlob: Buffer.from(input.update),
    workspaceId: scope.workspaceId,
  });

  const invalidated = await transaction
    .update(documentApprovals)
    .set({
      invalidatedAt: timestamp,
      invalidatedPrincipalId: input.principalId,
      invalidatedSeq: seq,
    })
    .where(and(
      eq(documentApprovals.workspaceId, scope.workspaceId),
      eq(documentApprovals.documentId, input.documentId),
      isNull(documentApprovals.invalidatedAt),
      isNull(documentApprovals.revokedAt),
    ))
    .returning({ id: documentApprovals.id });
  const readinessChanged = await transaction
    .update(documents)
    .set({
      readiness: "needs_review",
      ...(!projectedDuringRotation && { revision: sql`${documents.revision} + 1` }),
      updatedAt: timestamp,
    })
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, input.documentId),
      invalidated[0] ? undefined : eq(documents.readiness, "approved"),
    ))
    .returning({ readiness: documents.readiness });
  const receipt: DurableUpdateReceipt = {
    checksum: updateChecksum,
    documentId: input.documentId,
    generation: appendGeneration,
    headSeq: seq,
    seq,
    workflowChanged: invalidated.length > 0 || readinessChanged.length > 0,
  };
  position.revisionAdvanced = position.revisionAdvanced || receipt.workflowChanged;
  const result = lifecycle
    ? await lifecycle.commit(transaction, {
        plan: lifecycle.plan,
        position,
        receipt,
        snapshot: loaded,
      })
    : undefined;
  return { receipt, result, update: input.update };
}

async function resolveServerCommandReplay<TResult>(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: ServerCommandAppendIdentity,
  snapshot: CollaborationSnapshot,
  replay: (
    transaction: CollaborationTransaction,
    input: {
      receipt: DurableUpdateReceipt;
      snapshot: CollaborationSnapshot;
      update: Uint8Array | null;
    },
  ) => Promise<TResult>,
): Promise<CommitServerCommandResult<TResult> | null> {
  const stored = await findIdempotentReceipt(transaction, scope, input);
  if (!stored) return null;
  if (!matchesServerCommandReplayIdentity(stored, input)) {
    throw persistenceError("idempotency_conflict", false);
  }
  if (
    stored.kind === "update"
    && checksum(stored.stored.updateBlob) !== stored.stored.checksum
  ) {
    throw persistenceError("corrupt_state", false);
  }
  const receipt = durableReceipt(stored);
  const update = stored.kind === "update"
    ? Uint8Array.from(stored.stored.updateBlob)
    : null;
  return {
    receipt,
    replayed: true,
    result: await replay(transaction, { receipt, snapshot, update }),
    update,
  };
}

async function planServerCommandInIsolation<TPlan>(
  transaction: CollaborationTransaction,
  snapshot: CollaborationSnapshot,
  plan: (
    transaction: CollaborationTransaction,
    snapshot: CollaborationSnapshot,
  ) => Promise<{ plan: TPlan; update: Uint8Array }>,
) {
  const planningDocument = new Y.Doc();
  Y.applyUpdate(planningDocument, Y.encodeStateAsUpdate(snapshot.document));
  try {
    return await plan(transaction, {
      ...snapshot,
      document: planningDocument,
    });
  } finally {
    planningDocument.destroy();
  }
}

function mapServerCommandAppendInput(
  input: ServerCommandAppendIdentity,
  snapshot: CollaborationSnapshot,
  update: Uint8Array,
): AppendCollaborationUpdate {
  return {
    diagnosticJson: input.diagnosticJson,
    documentId: input.documentId,
    generation: snapshot.generation,
    idempotencyKey: input.idempotencyKey,
    originKind: input.originKind,
    principalId: input.principalId,
    requestId: input.requestId,
    semanticActionId: input.semanticActionId,
    sessionId: input.sessionId,
    update,
  };
}

export function createCollaborationPersistence(
  database: CollaborationDatabase,
  options: CollaborationPersistenceOptions = {},
): CollaborationPersistence {
  const projectProfile = options.projectProfile ?? resolveActiveProjectProfile();
  const codec = options.codec ?? createCollaborationDocumentCodec(projectProfile);
  const now = options.now ?? (() => new Date());
  const repository = createCollaborationRepository(database);
  const storageLimits = {
    checkpointBytes: options.storageLimits?.checkpointBytes ?? COLLABORATION_STORAGE_LIMITS.codecBytes,
    cumulativeUpdateBytes:
      options.storageLimits?.cumulativeUpdateBytes ?? DEFAULT_CUMULATIVE_UPDATE_BYTES,
  };

  const initialize = (scope: WorkspaceScope, documentId: string) => executePersistenceOperation(() => {
    validateScopeAndDocument(scope, documentId);
    return withSerializedDocumentWrite(scope, documentId, () => repository.write((transaction) =>
      ensureInitializedInTransaction(
        transaction,
        scope,
        documentId,
        codec,
        projectProfile,
        storageLimits.checkpointBytes,
        now,
      )));
  });

  const appendInTransaction = async <TPlan, TResult>(
    transaction: CollaborationTransaction,
    scope: WorkspaceScope,
    input: AppendCollaborationUpdate,
    loaded: CollaborationSnapshot,
    authorizationEpoch?: number,
    lifecycle?: ServerCommandLifecycle<TPlan, TResult>,
  ): Promise<AppendInTransactionResult<TResult>> => {
    await assertAppendableDocument(transaction, scope, input.documentId);
    if (authorizationEpoch !== undefined) {
      await assertAuthorizedClientAppend(transaction, scope, input, authorizationEpoch);
    }
    const updateChecksum = checksum(input.update);
    const replay = await resolveAppendReplay<TResult>(transaction, scope, input, updateChecksum);
    if (replay) return replay;
    if (loaded.generation !== input.generation) {
      throw persistenceError("stale_generation", true);
    }

    const { evaluation, mustRotate, timestamp } = await evaluateAppendInTransaction(
      transaction,
      scope,
      input,
      loaded,
      codec,
      projectProfile,
      storageLimits,
      now,
    );

    if (!evaluation.changed) {
      return commitNoopAppend(
        transaction,
        scope,
        input,
        loaded,
        updateChecksum,
        timestamp,
        lifecycle,
      );
    }

    const positionBasis = await rotateAppendInTransaction(
      transaction,
      scope,
      input,
      loaded,
      evaluation,
      mustRotate,
      storageLimits.cumulativeUpdateBytes,
      timestamp,
    );
    return commitChangedAppend(
      transaction,
      scope,
      input,
      loaded,
      updateChecksum,
      timestamp,
      positionBasis,
      lifecycle,
    );
  };

  const append = (
    scope: WorkspaceScope,
    input: AppendCollaborationUpdate,
    authorizationEpoch?: number,
  ) => executePersistenceOperation(() => {
        validateScopeAndDocument(scope, input.documentId);
        validateAppendInput(input);
        return withSerializedDocumentWrite(scope, input.documentId, () => repository.write(async (transaction) => {
        const loaded = await ensureInitializedInTransaction(
          transaction,
          scope,
          input.documentId,
          codec,
          projectProfile,
          storageLimits.checkpointBytes,
          now,
        );
        const appended = await appendInTransaction(
          transaction,
          scope,
          input,
          loaded,
          authorizationEpoch,
        );
        return appended.receipt;
        }));
      });

  return {
    appendAuthorizedClientUpdate(scope, input) {
      if (input.originKind !== "client") {
        throw persistenceError("invalid_input", false);
      }
      validateAuthorizationEpoch(input.authorizationEpoch);
      return append(scope, input, input.authorizationEpoch);
    },

    appendValidatedUpdate(scope, input) {
      return append(scope, input);
    },

    checkpoint(scope, documentId, generation) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, documentId);
        validateGeneration(generation);
        return repository.write(async (transaction) => {
        const loaded = await loadSnapshot(
          transaction,
          scope,
          documentId,
          codec,
          projectProfile,
        );
        if (!loaded) throw persistenceError("not_found", false);
        if (loaded.generation !== generation) {
          throw persistenceError("stale_generation", true);
        }
        let checkpoint: Uint8Array;
        let materialization: CollaborationMaterialization | undefined;
        try {
          checkpoint = codec.encodeCheckpoint(loaded.document);
          if (loaded.projectedSeq < loaded.headSeq) {
            materialization = codec.materialize(loaded.document);
          }
        } catch {
          throw persistenceError("storage_budget", true);
        }
        if (checkpoint.byteLength > storageLimits.checkpointBytes) {
          throw persistenceError("storage_budget", true);
        }
        const timestamp = now();
        const checkpointChecksum = checksum(checkpoint);
        const updated = await transaction
          .update(collaborationDocuments)
          .set({
            checkpointBlob: Buffer.from(checkpoint),
            checkpointChecksum,
            checkpointSeq: loaded.headSeq,
            lastCheckpointAt: timestamp,
            projectedSeq: loaded.headSeq,
            updatedAt: timestamp,
          })
          .where(and(
            eq(collaborationDocuments.workspaceId, scope.workspaceId),
            eq(collaborationDocuments.documentId, documentId),
            eq(collaborationDocuments.generation, generation),
            eq(collaborationDocuments.isCurrent, true),
            eq(collaborationDocuments.headSeq, loaded.headSeq),
          ))
          .returning({ generation: collaborationDocuments.generation });
        if (!updated[0]) throw new CollaborationCasRetryError();
        if (materialization) {
          await writeMaterializedDocument(
            transaction,
            scope,
            documentId,
            materialization,
            timestamp,
          );
        }
        return {
          checkpointSeq: loaded.headSeq,
          checksum: checkpointChecksum,
          documentId,
          generation,
          projectedSeq: loaded.headSeq,
        };
        });
      });
    },

    commitServerCommand<TPlan, TResult>(
      scope: WorkspaceScope,
      input: ServerCommandAppendIdentity,
      operations: {
        commit(
          transaction: CollaborationTransaction,
          input: {
            plan: TPlan;
            position: ServerCommandAppendPosition;
            receipt: DurableUpdateReceipt;
            snapshot: CollaborationSnapshot;
          },
        ): Promise<TResult>;
        plan(
          transaction: CollaborationTransaction,
          snapshot: CollaborationSnapshot,
        ): Promise<{ plan: TPlan; update: Uint8Array }>;
        prepare(
          transaction: CollaborationTransaction,
          input: {
            plan: TPlan;
            position: ServerCommandAppendPosition;
            snapshot: CollaborationSnapshot;
          },
        ): Promise<void>;
        replay(
          transaction: CollaborationTransaction,
          input: {
            receipt: DurableUpdateReceipt;
            snapshot: CollaborationSnapshot;
            update: Uint8Array | null;
          },
        ): Promise<TResult>;
      },
    ) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, input.documentId);
        validateGeneration(input.expectedGeneration);
        validateReplayIdentity({
          documentId: input.documentId,
          idempotencyKey: input.idempotencyKey,
          originKind: input.originKind,
          principalId: input.principalId,
          requestId: input.requestId,
          semanticActionId: input.semanticActionId,
          sessionId: input.sessionId,
        });
        if (input.originKind !== "proposal_command" && input.originKind !== "undo_command") {
          throw persistenceError("invalid_input", false);
        }
        return withSerializedDocumentWrite(scope, input.documentId, () =>
          repository.write(async (transaction) => {
            const snapshot = await ensureInitializedInTransaction(
              transaction,
              scope,
              input.documentId,
              codec,
              projectProfile,
              storageLimits.checkpointBytes,
              now,
            );
            await assertAppendableDocument(transaction, scope, input.documentId);
            const replay = await resolveServerCommandReplay(
              transaction,
              scope,
              input,
              snapshot,
              (replayTransaction, replayInput) => operations.replay(replayTransaction, replayInput),
            );
            if (replay) return replay;
            if (snapshot.generation !== input.expectedGeneration) {
              throw persistenceError("stale_generation", true);
            }
            const planned = await planServerCommandInIsolation(
              transaction,
              snapshot,
              (planTransaction, planningSnapshot) => operations.plan(planTransaction, planningSnapshot),
            );
            const appendInput = mapServerCommandAppendInput(input, snapshot, planned.update);
            validateAppendInput(appendInput);
            const appended = await appendInTransaction(
              transaction,
              scope,
              appendInput,
              snapshot,
              undefined,
              {
                commit: operations.commit,
                plan: planned.plan,
                prepare: operations.prepare,
              },
            );
            return {
              receipt: appended.receipt,
              replayed: false,
              result: appended.result as TResult,
              update: appended.update,
            };
          }));
      });
    },

    findDurableUpdateReplay(scope, identity) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, identity.documentId);
        validateReplayIdentity(identity);
        return repository.read(async (transaction) => {
          const stored = await findIdempotentReceipt(transaction, scope, identity);
          if (!stored) return null;
          if (!matchesDurableReplayIdentity(stored, identity)) {
            throw persistenceError("idempotency_conflict", false);
          }
          if (
            stored.kind === "update"
            && checksum(stored.stored.updateBlob) !== stored.stored.checksum
          ) {
            throw persistenceError("corrupt_state", false);
          }
          return {
            receipt: durableReceipt(stored),
            update: stored.kind === "update"
              ? Uint8Array.from(stored.stored.updateBlob)
              : null,
          };
        });
      });
    },

    initialize,

    load(scope, documentId) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, documentId);
        return repository.read((transaction) => loadSnapshot(
          transaction,
          scope,
          documentId,
          codec,
          projectProfile,
        ));
      });
    },

    project(scope, documentId, throughSeq) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, documentId);
        validateSequence(throughSeq);
        return repository.write(async (transaction) => {
        const loaded = await loadSnapshot(
          transaction,
          scope,
          documentId,
          codec,
          projectProfile,
          throughSeq,
        );
        if (!loaded) throw persistenceError("not_found", false);
        if (loaded.projectedSeq >= throughSeq) {
          const [document] = await transaction
            .select({ revision: documents.revision })
            .from(documents)
            .where(and(
              eq(documents.workspaceId, scope.workspaceId),
              eq(documents.id, documentId),
            ))
            .limit(1);
          if (!document) throw persistenceError("corrupt_state", false);
          return {
            documentId,
            generation: loaded.generation,
            projectedSeq: loaded.projectedSeq,
            revision: document.revision,
          };
        }
        const materialization = codec.materialize(loaded.document);
        const timestamp = now();
        const advanced = await transaction
          .update(collaborationDocuments)
          .set({ projectedSeq: throughSeq, updatedAt: timestamp })
          .where(and(
            eq(collaborationDocuments.workspaceId, scope.workspaceId),
            eq(collaborationDocuments.documentId, documentId),
            eq(collaborationDocuments.generation, loaded.generation),
            eq(collaborationDocuments.isCurrent, true),
            gte(collaborationDocuments.headSeq, throughSeq),
            lte(collaborationDocuments.checkpointSeq, throughSeq),
            lt(collaborationDocuments.projectedSeq, throughSeq),
          ))
          .returning({ generation: collaborationDocuments.generation });
        if (!advanced[0]) throw new CollaborationCasRetryError();
        const revision = await writeMaterializedDocument(
          transaction,
          scope,
          documentId,
          materialization,
          timestamp,
        );
        return {
          documentId,
          generation: loaded.generation,
          projectedSeq: throughSeq,
          revision,
        };
        });
      });
    },

    withInitializedWrite<T>(
      scope: WorkspaceScope,
      documentId: string,
      operation: (
        transaction: CollaborationTransaction,
        snapshot: CollaborationSnapshot,
      ) => Promise<T>,
    ) {
      return executePersistenceOperation(() => {
        validateScopeAndDocument(scope, documentId);
        return withSerializedDocumentWrite(scope, documentId, () => repository.write(async (transaction) => {
          const snapshot = await ensureInitializedInTransaction(
            transaction,
            scope,
            documentId,
            codec,
            projectProfile,
            storageLimits.checkpointBytes,
            now,
          );
          return operation(transaction, snapshot);
        }));
      });
    },
  };
}

async function planAppendStorage(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  loaded: CollaborationSnapshot,
  updateBytes: number,
  cumulativeLimitBytes: number,
) {
  const [storageState] = await transaction
    .select({
      checkpointBytes: sql<number>`length(${collaborationDocuments.checkpointBlob})`,
      checkpointSeq: collaborationDocuments.checkpointSeq,
    })
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, loaded.documentId),
      eq(collaborationDocuments.generation, loaded.generation),
      eq(collaborationDocuments.isCurrent, true),
    ))
    .limit(1);
  if (!storageState) throw new CollaborationCasRetryError();
  const [{ tailBytes }] = await transaction
    .select({ tailBytes: sql<number>`coalesce(sum(length(${collaborationUpdates.updateBlob})), 0)` })
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, loaded.documentId),
      eq(collaborationUpdates.generation, loaded.generation),
      gt(collaborationUpdates.seq, storageState.checkpointSeq),
    ));
  return shouldRotateAppend({
    checkpointBytes: Number(storageState.checkpointBytes),
    cumulativeLimitBytes,
    tailBytes: Number(tailBytes ?? 0),
    updateBytes,
  });
}

async function ensureInitializedInTransaction(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  documentId: string,
  codec: CollaborationDocumentCodec,
  projectProfile: ProjectProfile,
  checkpointBytes: number,
  now: () => Date,
) {
  const existing = await loadSnapshot(
    transaction,
    scope,
    documentId,
    codec,
    projectProfile,
  );
  if (existing) return existing;

  const [history] = await transaction
    .select({ generation: collaborationDocuments.generation })
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, documentId),
    ))
    .limit(1);
  if (history) throw persistenceError("corrupt_state", false);

  const [legacy] = await transaction
    .select()
    .from(documents)
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, documentId),
      eq(documents.status, "draft"),
    ))
    .limit(1);
  if (!legacy) throw persistenceError("not_found", false);

  let document: Y.Doc;
  let checkpoint: Uint8Array;
  try {
    document = codec.bootstrap({
      contentJson: legacy.contentJson,
      metadataJson: legacy.metadataJson,
      plainText: legacy.plainText,
      title: legacy.title,
    });
    checkpoint = codec.encodeCheckpoint(document);
  } catch (error) {
    if (
      error instanceof CollaborationCodecError
      && error.failure.reason === "checkpoint_budget"
    ) {
      throw persistenceError("storage_budget", true);
    }
    throw persistenceError("corrupt_state", false);
  }
  if (checkpoint.byteLength > checkpointBytes) {
    throw persistenceError("storage_budget", true);
  }
  const timestamp = now();
  await transaction.insert(collaborationDocuments).values({
    checkpointBlob: Buffer.from(checkpoint),
    checkpointChecksum: checksum(checkpoint),
    checkpointSeq: 0,
    createdAt: timestamp,
    documentId,
    generation: 1,
    headSeq: 0,
    isCurrent: true,
    lastCheckpointAt: timestamp,
    projectedSeq: 0,
    schemaFingerprint: codec.fingerprint(),
    schemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    updatedAt: timestamp,
    workspaceId: scope.workspaceId,
  });
  await transaction.update(aiProposals).set({
    status: "rejected",
    updatedAt: timestamp,
  }).where(and(
    eq(aiProposals.workspaceId, scope.workspaceId),
    eq(aiProposals.documentId, documentId),
    eq(aiProposals.status, "pending"),
  ));

  const initialized = await loadSnapshot(
    transaction,
    scope,
    documentId,
    codec,
    projectProfile,
  );
  if (!initialized) throw persistenceError("corrupt_state", false);
  return initialized;
}

async function assertAppendableDocument(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  documentId: string,
) {
  const [draft] = await transaction
    .select({ id: documents.id })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, documentId),
      eq(documents.status, "draft"),
    ))
    .limit(1);
  if (!draft) throw persistenceError("not_found", false);
}

async function assertAuthorizedClientAppend(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
  expectedAuthorizationEpoch: number,
) {
  const current = await transaction
    .select({
      authorizationEpoch: sql<number>`coalesce(${collaborationAuthorizationEpochs.epoch}, 0)`,
      generation: collaborationDocuments.generation,
    })
    .from(documents)
    .innerJoin(
      collaborationDocuments,
      and(
        eq(collaborationDocuments.workspaceId, documents.workspaceId),
        eq(collaborationDocuments.documentId, documents.id),
        eq(collaborationDocuments.isCurrent, true),
      ),
    )
    .leftJoin(
      collaborationAuthorizationEpochs,
      and(
        eq(collaborationAuthorizationEpochs.workspaceId, documents.workspaceId),
        eq(collaborationAuthorizationEpochs.principalId, input.principalId),
      ),
    )
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, input.documentId),
      eq(documents.status, "draft"),
      eq(collaborationDocuments.generation, input.generation),
    ))
    .limit(2);
  if (
    current.length !== 1
    || Number(current[0]!.authorizationEpoch) !== expectedAuthorizationEpoch
    || current[0]!.generation !== input.generation
  ) {
    throw persistenceError("authorization_revoked", false);
  }
}

async function loadSnapshot(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  documentId: string,
  codec: CollaborationDocumentCodec,
  projectProfile: ProjectProfile,
  throughSeq?: number,
): Promise<CollaborationSnapshot | null> {
  const currentRows = await transaction
    .select()
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, documentId),
      eq(collaborationDocuments.isCurrent, true),
    ))
    .limit(2);
  if (currentRows.length === 0) return null;
  if (currentRows.length !== 1) throw persistenceError("corrupt_state", false);
  const current = currentRows[0]!;
  if (
    current.schemaVersion !== COLLABORATION_DOCUMENT_SCHEMA_VERSION
    || current.schemaFingerprint !== codec.fingerprint()
  ) {
    throw persistenceError("schema_mismatch", false);
  }
  if (checksum(current.checkpointBlob) !== current.checkpointChecksum) {
    throw persistenceError("checksum_mismatch", false);
  }
  const targetSeq = throughSeq ?? current.headSeq;
  if (
    !Number.isSafeInteger(targetSeq)
    || targetSeq < current.checkpointSeq
    || targetSeq > current.headSeq
  ) {
    throw persistenceError("projection_fence", false);
  }
  const [orphanedFutureUpdate] = await transaction
    .select({ seq: collaborationUpdates.seq })
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, documentId),
      eq(collaborationUpdates.generation, current.generation),
      gt(collaborationUpdates.seq, current.headSeq),
    ))
    .limit(1);
  if (orphanedFutureUpdate) throw persistenceError("corrupt_state", false);

  let document: Y.Doc;
  try {
    document = codec.loadCheckpoint(current.checkpointBlob);
  } catch {
    throw persistenceError("corrupt_state", false);
  }
  const tail = await transaction
    .select()
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, documentId),
      eq(collaborationUpdates.generation, current.generation),
      gt(collaborationUpdates.seq, current.checkpointSeq),
      lte(collaborationUpdates.seq, targetSeq),
    ))
    .orderBy(asc(collaborationUpdates.seq));
  let expectedSeq = current.checkpointSeq + 1;
  for (const update of tail) {
    if (update.seq !== expectedSeq) throw persistenceError("corrupt_state", false);
    if (checksum(update.updateBlob) !== update.checksum) {
      throw persistenceError("checksum_mismatch", false);
    }
    try {
      Y.applyUpdate(document, update.updateBlob, "durable-tail-replay");
    } catch {
      throw persistenceError("corrupt_state", false);
    }
    expectedSeq += 1;
  }
  if (expectedSeq !== targetSeq + 1) throw persistenceError("corrupt_state", false);
  try {
    codec.validate(document, projectProfile);
  } catch {
    throw persistenceError("corrupt_state", false);
  }
  return {
    checkpointSeq: current.checkpointSeq,
    document,
    documentId,
    generation: current.generation,
    headSeq: targetSeq,
    projectedSeq: current.projectedSeq,
    schemaFingerprint: current.schemaFingerprint,
    schemaVersion: current.schemaVersion,
  };
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function persistenceError(
  category: CollaborationPersistenceCategory,
  retryable: boolean,
) {
  return new CollaborationPersistenceError(category, retryable);
}

class CollaborationCasRetryError extends Error {
  readonly code = "SQLITE_BUSY_COLLABORATION_CAS";

  constructor() {
    super("Collaboration compare-and-set must be retried");
  }
}

async function executePersistenceOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CollaborationPersistenceError) throw error;
    if (isRetryableSqliteContention(error)) {
      throw persistenceError("contention", true);
    }
    throw persistenceError("internal", false);
  }
}

const COLLABORATION_ORIGIN_KINDS = new Set<CollaborationUpdateOriginKind>([
  "client",
  "migration",
  "proposal_command",
  "repair",
  "undo_command",
]);
const COLLABORATION_BOUNDARY_WHITESPACE = /^[\t\n\v\f\r \u00a0]|[\t\n\v\f\r \u00a0]$/u;
const UTF8_ENCODER = new TextEncoder();

function validateAppendInput(input: AppendCollaborationUpdate) {
  validateGeneration(input.generation);
  if (!(input.update instanceof Uint8Array)
    || input.update.byteLength < 1
    || input.update.byteLength > COLLABORATION_STORAGE_LIMITS.codecBytes) {
    throw persistenceError("invalid_input", false);
  }
  validateBoundedText(input.idempotencyKey);
  validateBoundedText(input.principalId);
  validateOptionalBoundedText(input.requestId);
  validateOptionalBoundedText(input.sessionId);
  validateOptionalBoundedText(input.semanticActionId);
  if (!COLLABORATION_ORIGIN_KINDS.has(input.originKind)) {
    throw persistenceError("invalid_input", false);
  }
  if (input.diagnosticJson !== undefined) validateDiagnosticJson(input.diagnosticJson);
}

function validateReplayIdentity(identity: DurableUpdateReplayIdentity) {
  validateBoundedText(identity.idempotencyKey);
  validateBoundedText(identity.principalId);
  validateOptionalBoundedText(identity.requestId);
  validateOptionalBoundedText(identity.sessionId);
  validateOptionalBoundedText(identity.semanticActionId);
  if (!COLLABORATION_ORIGIN_KINDS.has(identity.originKind)) {
    throw persistenceError("invalid_input", false);
  }
}

function validateScopeAndDocument(scope: WorkspaceScope, documentId: string) {
  validateBoundedText(scope.workspaceId);
  validateBoundedText(documentId);
}

function validateGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw persistenceError("invalid_input", false);
  }
}

function validateAuthorizationEpoch(epoch: number) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw persistenceError("invalid_input", false);
  }
}

function validateSequence(sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw persistenceError("invalid_input", false);
  }
}

function validateOptionalBoundedText(value: string | undefined) {
  if (value !== undefined) validateBoundedText(value);
}

function validateBoundedText(value: string) {
  if (typeof value !== "string" || COLLABORATION_BOUNDARY_WHITESPACE.test(value)) {
    throw persistenceError("invalid_input", false);
  }
  const bytes = UTF8_ENCODER.encode(value).byteLength;
  if (bytes < 1 || bytes > COLLABORATION_STORAGE_LIMITS.correctnessKeyBytes) {
    throw persistenceError("invalid_input", false);
  }
}

function validateDiagnosticJson(value: Record<string, unknown>) {
  try {
    if (!isPlainJsonObject(value) || !isJsonValue(value, new Set())) {
      throw new Error("invalid diagnostic");
    }
    const serialized = JSON.stringify(value);
    const bytes = UTF8_ENCODER.encode(serialized).byteLength;
    if (bytes < 2 || bytes > COLLABORATION_STORAGE_LIMITS.diagnosticJsonBytes) {
      throw new Error("invalid diagnostic size");
    }
  } catch {
    throw persistenceError("invalid_input", false);
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = Object.getOwnPropertySymbols(value).length === 0
      && Object.keys(value).length === value.length
      && value.every((item) => isJsonValue(item, ancestors));
  } else if (isPlainJsonObject(value)) {
    valid = Object.getOwnPropertySymbols(value).length === 0
      && Object.values(value).every((item) => isJsonValue(item, ancestors));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type StoredIdempotentReceipt =
  | { kind: "noop"; stored: typeof collaborationNoopReceipts.$inferSelect }
  | { kind: "update"; stored: typeof collaborationUpdates.$inferSelect };

async function findIdempotentReceipt(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: Pick<AppendCollaborationUpdate, "documentId" | "idempotencyKey">,
): Promise<StoredIdempotentReceipt | null> {
  // 0016 deliberately has no synthetic backfill: pre-0016 changed appends keep
  // replaying from collaboration_updates, while new no-op appends use receipts.
  const updateRows = await transaction
    .select()
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, input.documentId),
      eq(collaborationUpdates.idempotencyKey, input.idempotencyKey),
    ))
    .orderBy(asc(collaborationUpdates.generation), asc(collaborationUpdates.seq))
    .limit(2);
  const noOpRows = await transaction
    .select()
    .from(collaborationNoopReceipts)
    .where(and(
      eq(collaborationNoopReceipts.workspaceId, scope.workspaceId),
      eq(collaborationNoopReceipts.documentId, input.documentId),
      eq(collaborationNoopReceipts.idempotencyKey, input.idempotencyKey),
    ))
    .limit(2);
  if (updateRows.length + noOpRows.length > 1) {
    throw persistenceError("corrupt_state", false);
  }
  const receipt: StoredIdempotentReceipt | null = noOpRows[0]
    ? { kind: "noop", stored: noOpRows[0] }
    : updateRows[0]
      ? { kind: "update", stored: updateRows[0] }
      : null;
  if (receipt) await assertReceiptGenerationFence(transaction, receipt);
  return receipt;
}

async function assertReceiptGenerationFence(
  transaction: CollaborationTransaction,
  receipt: StoredIdempotentReceipt,
) {
  const { stored } = receipt;
  const generations = await transaction
    .select({ headSeq: collaborationDocuments.headSeq })
    .from(collaborationDocuments)
    .where(and(
      eq(collaborationDocuments.workspaceId, stored.workspaceId),
      eq(collaborationDocuments.documentId, stored.documentId),
      eq(collaborationDocuments.generation, stored.generation),
    ))
    .limit(2);
  const receiptSeq = receipt.kind === "noop" ? receipt.stored.headSeq : receipt.stored.seq;
  if (generations.length !== 1 || receiptSeq > generations[0]!.headSeq) {
    throw persistenceError("corrupt_state", false);
  }
}

function matchesIdempotentReceipt(
  receipt: StoredIdempotentReceipt,
  input: AppendCollaborationUpdate,
  updateChecksum: string,
) {
  const { stored } = receipt;
  return stored.checksum === updateChecksum
    && stored.originKind === input.originKind
    && stored.principalId === input.principalId
    && stored.requestId === (input.requestId ?? null)
    && stored.sessionId === (input.sessionId ?? null)
    && stored.semanticActionId === (input.semanticActionId ?? null);
}

function matchesDurableReplayIdentity(
  receipt: StoredIdempotentReceipt,
  input: DurableUpdateReplayIdentity,
) {
  const { stored } = receipt;
  return stored.originKind === input.originKind
    && stored.principalId === input.principalId
    && (input.requestId === undefined || stored.requestId === input.requestId)
    && stored.sessionId === (input.sessionId ?? null)
    && stored.semanticActionId === (input.semanticActionId ?? null);
}

function matchesServerCommandReplayIdentity(
  receipt: StoredIdempotentReceipt,
  input: ServerCommandAppendIdentity,
) {
  const { stored } = receipt;
  return stored.originKind === input.originKind
    && stored.principalId === input.principalId
    && stored.sessionId === (input.sessionId ?? null)
    && stored.semanticActionId === (input.semanticActionId ?? null);
}

function durableReceipt(receipt: StoredIdempotentReceipt): DurableUpdateReceipt {
  const { stored } = receipt;
  const headSeq = receipt.kind === "noop" ? receipt.stored.headSeq : receipt.stored.seq;
  return {
    checksum: stored.checksum,
    documentId: stored.documentId,
    generation: stored.generation,
    headSeq,
    seq: headSeq,
    workflowChanged: false,
  };
}

async function writeMaterializedDocument(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  documentId: string,
  materialization: CollaborationMaterialization,
  timestamp: Date,
) {
  const [document] = await transaction
    .update(documents)
    .set({
      contentJson: materialization.contentJson,
      metadataJson: materialization.metadataJson,
      plainText: materialization.plainText,
      revision: sql`${documents.revision} + 1`,
      title: materialization.title,
      updatedAt: timestamp,
    })
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, documentId),
    ))
    .returning({ revision: documents.revision });
  if (!document) throw persistenceError("corrupt_state", false);
  return document.revision;
}
