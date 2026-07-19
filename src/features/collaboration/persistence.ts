import { createHash } from "node:crypto";

import { and, asc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import * as Y from "yjs";

import {
  COLLABORATION_STORAGE_LIMITS,
  collaborationDocuments,
  collaborationUpdates,
  documentApprovals,
  documents,
  type CollaborationUpdateOriginKind,
} from "@/db/schema";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import type { ProjectProfile } from "@/features/projects/project-profile";

import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  type CollaborationDocumentCodec,
  type CollaborationMaterialization,
} from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
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
  | "corrupt_state"
  | "idempotency_conflict"
  | "not_found"
  | "projection_fence"
  | "schema_mismatch"
  | "stale_generation"
  | "storage_budget";

const ERROR_MESSAGES: Record<CollaborationPersistenceCategory, string> = {
  checksum_mismatch: "Collaboration state checksum validation failed",
  corrupt_state: "Collaboration state recovery failed",
  idempotency_conflict: "Collaboration idempotency identity conflicts with durable state",
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

  const initialize = (scope: WorkspaceScope, documentId: string) =>
    withSerializedDocumentWrite(scope, documentId, () => repository.write(async (transaction) => {
      const existing = await loadSnapshot(
        transaction,
        scope,
        documentId,
        codec,
        projectProfile,
      );
      if (existing) return existing;

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

      const document = codec.bootstrap({
        contentJson: legacy.contentJson,
        metadataJson: legacy.metadataJson,
        plainText: legacy.plainText,
        title: legacy.title,
      });
      const checkpoint = codec.encodeCheckpoint(document);
      if (checkpoint.byteLength > storageLimits.checkpointBytes) {
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
      }).onConflictDoNothing();

      const initialized = await loadSnapshot(
        transaction,
        scope,
        documentId,
        codec,
        projectProfile,
      );
      if (!initialized) throw persistenceError("corrupt_state", false);
      return initialized;
    }));

  return {
    async appendValidatedUpdate(scope, input) {
      validateAppendInput(input);
      await initialize(scope, input.documentId);
      return repository.write(async (transaction) => {
        const updateChecksum = checksum(input.update);
        const replay = await findIdempotentUpdate(transaction, scope, input);
        if (replay) {
          if (!matchesIdempotentUpdate(replay, input, updateChecksum)) {
            throw persistenceError("idempotency_conflict", false);
          }
          return updateReceipt(replay);
        }

        const loaded = await loadSnapshot(
          transaction,
          scope,
          input.documentId,
          codec,
          projectProfile,
        );
        if (!loaded) throw persistenceError("not_found", false);
        if (loaded.generation !== input.generation) {
          throw persistenceError("stale_generation", true);
        }

        const [storageState] = await transaction
          .select({
            checkpointBytes: sql<number>`length(${collaborationDocuments.checkpointBlob})`,
            checkpointSeq: collaborationDocuments.checkpointSeq,
          })
          .from(collaborationDocuments)
          .where(and(
            eq(collaborationDocuments.workspaceId, scope.workspaceId),
            eq(collaborationDocuments.documentId, input.documentId),
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
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generation, loaded.generation),
            gt(collaborationUpdates.seq, storageState.checkpointSeq),
          ));
        const mustRotate = Number(storageState.checkpointBytes)
          + Number(tailBytes ?? 0)
          + input.update.byteLength
          > storageLimits.cumulativeUpdateBytes;
        let appendDocument = loaded.document;
        let appendGeneration = loaded.generation;
        let appendHeadSeq = loaded.headSeq;
        let projectedDuringRotation = false;
        const timestamp = now();

        if (mustRotate) {
          let rotationCheckpoint: Uint8Array;
          try {
            rotationCheckpoint = codec.encodeCheckpoint(loaded.document);
          } catch {
            throw persistenceError("storage_budget", true);
          }
          if (rotationCheckpoint.byteLength > storageLimits.checkpointBytes) {
            throw persistenceError("storage_budget", true);
          }
          if (
            rotationCheckpoint.byteLength + input.update.byteLength
            > storageLimits.cumulativeUpdateBytes
          ) {
            throw persistenceError("storage_budget", true);
          }
          let rotationMaterialization;
          try {
            rotationMaterialization = codec.materialize(loaded.document);
          } catch {
            throw persistenceError("storage_budget", true);
          }
          await writeMaterializedDocument(
            transaction,
            scope,
            input.documentId,
            rotationMaterialization,
            timestamp,
          );
          projectedDuringRotation = true;
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
            checkpointBlob: Buffer.from(rotationCheckpoint),
            checkpointChecksum: checksum(rotationCheckpoint),
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
          try {
            appendDocument = codec.loadCheckpoint(rotationCheckpoint);
          } catch {
            throw persistenceError("storage_budget", true);
          }
          appendHeadSeq = loaded.headSeq;
        }

        try {
          Y.applyUpdate(appendDocument, input.update, "durable-append-validation");
          codec.validate(appendDocument, projectProfile);
          const candidateCheckpoint = codec.encodeCheckpoint(appendDocument);
          if (candidateCheckpoint.byteLength > storageLimits.checkpointBytes) {
            throw persistenceError("storage_budget", true);
          }
        } catch (error) {
          if (error instanceof CollaborationPersistenceError) throw error;
          throw persistenceError("corrupt_state", false);
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
        if (invalidated[0]) {
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
            ));
        }

        return {
          checksum: updateChecksum,
          documentId: input.documentId,
          generation: appendGeneration,
          headSeq: seq,
          seq,
        };
      });
    },

    checkpoint(scope, documentId, generation) {
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
        let materialization;
        try {
          checkpoint = codec.encodeCheckpoint(loaded.document);
          materialization = codec.materialize(loaded.document);
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
        await writeMaterializedDocument(
          transaction,
          scope,
          documentId,
          materialization,
          timestamp,
        );
        return {
          checkpointSeq: loaded.headSeq,
          checksum: checkpointChecksum,
          documentId,
          generation,
          projectedSeq: loaded.headSeq,
        };
      });
    },

    initialize,

    load(scope, documentId) {
      return repository.read((transaction) => loadSnapshot(
        transaction,
        scope,
        documentId,
        codec,
        projectProfile,
      ));
    },

    project(scope, documentId, throughSeq) {
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
    },
  };
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

function validateAppendInput(input: AppendCollaborationUpdate) {
  if (
    !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || input.update.byteLength < 1
    || input.update.byteLength > COLLABORATION_STORAGE_LIMITS.codecBytes
  ) {
    throw persistenceError("corrupt_state", false);
  }
}

async function findIdempotentUpdate(
  transaction: CollaborationTransaction,
  scope: WorkspaceScope,
  input: AppendCollaborationUpdate,
) {
  const rows = await transaction
    .select()
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, input.documentId),
      eq(collaborationUpdates.idempotencyKey, input.idempotencyKey),
    ))
    .orderBy(asc(collaborationUpdates.generation), asc(collaborationUpdates.seq))
    .limit(2);
  if (rows.length > 1) throw persistenceError("corrupt_state", false);
  return rows[0] ?? null;
}

function matchesIdempotentUpdate(
  stored: typeof collaborationUpdates.$inferSelect,
  input: AppendCollaborationUpdate,
  updateChecksum: string,
) {
  return stored.checksum === updateChecksum
    && stored.originKind === input.originKind
    && stored.principalId === input.principalId
    && stored.requestId === (input.requestId ?? null)
    && stored.sessionId === (input.sessionId ?? null)
    && stored.semanticActionId === (input.semanticActionId ?? null);
}

function updateReceipt(stored: typeof collaborationUpdates.$inferSelect): DurableUpdateReceipt {
  return {
    checksum: stored.checksum,
    documentId: stored.documentId,
    generation: stored.generation,
    headSeq: stored.seq,
    seq: stored.seq,
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
