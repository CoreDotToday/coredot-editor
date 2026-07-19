import { createHash } from "node:crypto";

import { and, asc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import * as Y from "yjs";

import {
  COLLABORATION_STORAGE_LIMITS,
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
  appendValidatedUpdate(
    scope: WorkspaceScope,
    input: AppendCollaborationUpdate,
  ): Promise<DurableUpdateReceipt>;
  checkpoint(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ): Promise<CheckpointReceipt>;
  initialize(scope: WorkspaceScope, documentId: string): Promise<CollaborationSnapshot>;
  load(scope: WorkspaceScope, documentId: string): Promise<CollaborationSnapshot | null>;
  project(
    scope: WorkspaceScope,
    documentId: string,
    throughSeq: number,
  ): Promise<ProjectionReceipt>;
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

  return {
    appendValidatedUpdate(scope, input) {
      return executePersistenceOperation(() => {
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
        await assertAppendableDocument(transaction, scope, input.documentId);
        const updateChecksum = checksum(input.update);
        const replay = await findIdempotentReceipt(transaction, scope, input);
        if (replay) {
          if (!matchesIdempotentReceipt(replay, input, updateChecksum)) {
            throw persistenceError("idempotency_conflict", false);
          }
          return durableReceipt(replay);
        }

        if (loaded.generation !== input.generation) {
          throw persistenceError("stale_generation", true);
        }

        const mustRotate = await planAppendStorage(
          transaction,
          scope,
          loaded,
          input.update.byteLength,
          storageLimits.cumulativeUpdateBytes,
        );
        let appendGeneration = loaded.generation;
        let appendHeadSeq = loaded.headSeq;
        let projectedDuringRotation = false;
        const timestamp = now();
        let evaluation: ReturnType<typeof evaluateAppendCandidate>;
        try {
          evaluation = evaluateAppendCandidate({
            checkpointBytesLimit: storageLimits.checkpointBytes,
            codec,
            document: loaded.document,
            projectProfile,
            shouldMaterializeBeforeRotation: loaded.projectedSeq < loaded.headSeq,
            shouldRotate: mustRotate,
            update: input.update,
          });
        } catch (error) {
          if (error instanceof AppendCandidateEvaluationError) {
            throw persistenceError(error.failure, error.failure === "storage_budget");
          }
          throw error;
        }
        if (!evaluation.changed) {
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
          return {
            checksum: updateChecksum,
            documentId: input.documentId,
            generation: loaded.generation,
            headSeq: loaded.headSeq,
            seq: loaded.headSeq,
          };
        }

        if (mustRotate) {
          const rotation = evaluation.rotation;
          if (!rotation) throw persistenceError("corrupt_state", false);
          if (
            rotation.checkpoint.byteLength + input.update.byteLength
            > storageLimits.cumulativeUpdateBytes
          ) {
            throw persistenceError("storage_budget", true);
          }
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
            .set({
              isCurrent: false,
              projectedSeq: loaded.headSeq,
              updatedAt: timestamp,
            })
            .where(and(
              eq(collaborationDocuments.workspaceId, scope.workspaceId),
              eq(collaborationDocuments.documentId, input.documentId),
              eq(collaborationDocuments.generation, loaded.generation),
              eq(collaborationDocuments.isCurrent, true),
              eq(collaborationDocuments.headSeq, loaded.headSeq),
            ))
            .returning({ generation: collaborationDocuments.generation });
          if (!retired[0]) throw new CollaborationCasRetryError();
          appendGeneration = loaded.generation + 1;
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
          appendHeadSeq = loaded.headSeq;
        }

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
          ))
          .returning({ id: documentApprovals.id });
        await transaction
          .update(documents)
          .set({
            readiness: "needs_review",
            ...(!projectedDuringRotation && {
              revision: sql`${documents.revision} + 1`,
            }),
            updatedAt: timestamp,
          })
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, input.documentId),
            invalidated[0] ? undefined : eq(documents.readiness, "approved"),
          ));

        return {
          checksum: updateChecksum,
          documentId: input.documentId,
          generation: appendGeneration,
          headSeq: seq,
          seq,
        };
        }));
      });
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

function validateScopeAndDocument(scope: WorkspaceScope, documentId: string) {
  validateBoundedText(scope.workspaceId);
  validateBoundedText(documentId);
}

function validateGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
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
  input: AppendCollaborationUpdate,
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

function durableReceipt(receipt: StoredIdempotentReceipt): DurableUpdateReceipt {
  const { stored } = receipt;
  const headSeq = receipt.kind === "noop" ? receipt.stored.headSeq : receipt.stored.seq;
  return {
    checksum: stored.checksum,
    documentId: stored.documentId,
    generation: stored.generation,
    headSeq,
    seq: headSeq,
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
