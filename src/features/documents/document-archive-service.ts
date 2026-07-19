import { and, asc, eq, lte, sql } from "drizzle-orm";

import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  COLLABORATION_ROOM_CLOSURE_MAX_ATTEMPTS,
  collaborationDocuments,
  collaborationRoomClosureJobs,
  documents,
  type CollaborationRoomClosureJobRecord,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import {
  createCollaborationRepository,
  type CollaborationDatabase,
} from "@/features/collaboration/repository";

const DEFAULT_RECONCILE_BATCH = 25;
const MAX_RECONCILE_BATCH = 50;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;
const MAX_IDENTIFIER_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BOUNDARY_WHITESPACE = /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/;

export type DocumentArchiveResult =
  | { status: "not_found" }
  | {
      roomClosure: "not_required" | "delivered" | "pending";
      status: "already_archived" | "archived";
    };

export type RoomClosureReconciliation = {
  attempted: number;
  closed: number;
  exhausted: number;
  pending: number;
};

/**
 * Delivers the exact collaboration generation captured by an archive outbox
 * job. It is intentionally separate from CollaborativeDocumentGateway: an
 * archive retry must never re-resolve whichever generation is current later.
 */
export interface DocumentArchiveRoomGateway {
  closeArchivedRoom(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ): Promise<void>;
}

export class DocumentArchiveServiceError extends Error {
  override readonly name = "DocumentArchiveServiceError";

  constructor(readonly category: "invalid_input" | "unavailable") {
    super(category === "invalid_input"
      ? "Document archive command is invalid"
      : "Document archive service is unavailable");
  }
}

export function createDocumentArchiveService(options: {
  database: CollaborationDatabase;
  gateway?: DocumentArchiveRoomGateway;
  now?: () => Date;
}) {
  const repository = createCollaborationRepository(options.database);
  const now = options.now ?? (() => new Date());

  const archive = async (
    scope: WorkspaceScope,
    documentId: string,
  ): Promise<DocumentArchiveResult> => {
    validateScope(scope, documentId);
    return withSerializedDocumentWrite(scope, documentId, async () => {
      const timestamp = readTimestamp(now);
      const committed = await storage(async () => repository.write(async (transaction) => {
        const [document] = await transaction
          .select({ status: documents.status })
          .from(documents)
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, documentId),
          ))
          .limit(1);
        if (!document) return { status: "not_found" as const };
        if (document.status === "archived") {
          const [pendingJob] = await transaction
            .select({ status: collaborationRoomClosureJobs.status })
            .from(collaborationRoomClosureJobs)
            .where(and(
              eq(collaborationRoomClosureJobs.workspaceId, scope.workspaceId),
              eq(collaborationRoomClosureJobs.documentId, documentId),
            ))
            .limit(1);
          return {
            hasClosureJob: Boolean(pendingJob),
            status: "already_archived" as const,
          };
        }

        const [currentGeneration] = await transaction
          .select({ generation: collaborationDocuments.generation })
          .from(collaborationDocuments)
          .where(and(
            eq(collaborationDocuments.workspaceId, scope.workspaceId),
            eq(collaborationDocuments.documentId, documentId),
            eq(collaborationDocuments.isCurrent, true),
          ))
          .limit(1);
        const [archived] = await transaction
          .update(documents)
          .set({ creationKey: null, status: "archived", updatedAt: timestamp })
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, documentId),
            eq(documents.status, "draft"),
          ))
          .returning({ id: documents.id });
        if (!archived) throw new DocumentArchiveServiceError("unavailable");

        if (currentGeneration) {
          await transaction.insert(collaborationRoomClosureJobs).values({
            attempts: 0,
            createdAt: timestamp,
            documentId,
            failureCategory: null,
            generation: currentGeneration.generation,
            nextAttemptAt: timestamp,
            reason: "archived",
            status: "pending",
            updatedAt: timestamp,
            workspaceId: scope.workspaceId,
          });
        }
        return {
          roomGeneration: currentGeneration?.generation ?? null,
          status: "archived" as const,
        };
      }));

      if (committed.status === "not_found") return committed;
      if (committed.status === "already_archived") {
        return {
          roomClosure: committed.hasClosureJob ? "pending" : "not_required",
          status: committed.status,
        };
      }
      if (committed.roomGeneration === null) {
        return { roomClosure: "not_required", status: "archived" };
      }

      const roomClosure = await deliverClosure({
        documentId,
        expectedAttempts: 0,
        generation: committed.roomGeneration,
        scope,
      });
      return { roomClosure, status: "archived" };
    });
  };

  const deliverClosure = async (input: {
    documentId: string;
    expectedAttempts: number;
    generation: number;
    scope: WorkspaceScope;
  }): Promise<"delivered" | "pending"> => {
    const gateway = options.gateway;
    if (!gateway) return "pending";
    try {
      await gateway.closeArchivedRoom(
        input.scope,
        input.documentId,
        input.generation,
      );
    } catch {
      await recordDeliveryFailure(input).catch(() => undefined);
      return "pending";
    }

    try {
      await storage(async () => repository.write(async (transaction) => {
        await transaction.delete(collaborationRoomClosureJobs).where(and(
          eq(collaborationRoomClosureJobs.workspaceId, input.scope.workspaceId),
          eq(collaborationRoomClosureJobs.documentId, input.documentId),
          eq(collaborationRoomClosureJobs.generation, input.generation),
          eq(collaborationRoomClosureJobs.reason, "archived"),
          eq(collaborationRoomClosureJobs.status, "pending"),
        ));
      }));
      return "delivered";
    } catch {
      // The durable job deliberately remains due. Room close is idempotent, so
      // a reconciler can safely repeat delivery after an uncertain cleanup.
      return "pending";
    }
  };

  const recordDeliveryFailure = async (input: {
    documentId: string;
    expectedAttempts: number;
    generation: number;
    scope: WorkspaceScope;
  }) => {
    const nextAttempts = input.expectedAttempts + 1;
    const exhausted = nextAttempts >= COLLABORATION_ROOM_CLOSURE_MAX_ATTEMPTS;
    const timestamp = readTimestamp(now);
    await storage(async () => repository.write(async (transaction) => {
      await transaction.update(collaborationRoomClosureJobs).set({
        attempts: nextAttempts,
        failureCategory: "delivery_failed",
        nextAttemptAt: exhausted
          ? null
          : new Date(timestamp.valueOf() + retryDelay(nextAttempts)),
        status: exhausted ? "exhausted" : "pending",
        updatedAt: timestamp,
      }).where(and(
        eq(collaborationRoomClosureJobs.workspaceId, input.scope.workspaceId),
        eq(collaborationRoomClosureJobs.documentId, input.documentId),
        eq(collaborationRoomClosureJobs.generation, input.generation),
        eq(collaborationRoomClosureJobs.reason, "archived"),
        eq(collaborationRoomClosureJobs.status, "pending"),
        eq(collaborationRoomClosureJobs.attempts, input.expectedAttempts),
      ));
    }));
  };

  const reconcileDueRoomClosures = async (
    input: { limit?: number } = {},
  ): Promise<RoomClosureReconciliation> => {
    const limit = normalizeBatchLimit(input.limit);
    if (!options.gateway) {
      return { attempted: 0, closed: 0, ...await readJobCounts() };
    }
    const startedAt = readTimestamp(now);
    const jobs = await storage(async () => repository.read((transaction) => transaction
      .select()
      .from(collaborationRoomClosureJobs)
      .where(and(
        eq(collaborationRoomClosureJobs.status, "pending"),
        lte(collaborationRoomClosureJobs.nextAttemptAt, startedAt),
      ))
      .orderBy(
        asc(collaborationRoomClosureJobs.nextAttemptAt),
        asc(collaborationRoomClosureJobs.createdAt),
        asc(collaborationRoomClosureJobs.workspaceId),
        asc(collaborationRoomClosureJobs.documentId),
        asc(collaborationRoomClosureJobs.generation),
      )
      .limit(limit)));

    let attempted = 0;
    let closed = 0;
    for (const candidate of jobs) {
      const outcome = await withSerializedDocumentWrite(
        { workspaceId: candidate.workspaceId },
        candidate.documentId,
        async () => {
          const current = await readDueJob(candidate, startedAt);
          if (!current) return "skipped" as const;
          const result = await deliverClosure({
            documentId: current.documentId,
            expectedAttempts: current.attempts,
            generation: current.generation,
            scope: { workspaceId: current.workspaceId },
          });
          return result;
        },
      );
      if (outcome === "skipped") continue;
      attempted += 1;
      if (outcome === "delivered") closed += 1;
    }

    const counts = await readJobCounts();
    return { attempted, closed, ...counts };
  };

  const readDueJob = async (
    candidate: CollaborationRoomClosureJobRecord,
    dueAt: Date,
  ) => storage(async () => repository.read(async (transaction) => {
    const [job] = await transaction.select().from(collaborationRoomClosureJobs)
      .where(and(
        eq(collaborationRoomClosureJobs.workspaceId, candidate.workspaceId),
        eq(collaborationRoomClosureJobs.documentId, candidate.documentId),
        eq(collaborationRoomClosureJobs.generation, candidate.generation),
        eq(collaborationRoomClosureJobs.reason, candidate.reason),
        eq(collaborationRoomClosureJobs.status, "pending"),
        eq(collaborationRoomClosureJobs.attempts, candidate.attempts),
        lte(collaborationRoomClosureJobs.nextAttemptAt, dueAt),
      ))
      .limit(1);
    return job ?? null;
  }));

  const readJobCounts = async () => storage(async () => repository.read(async (transaction) => {
    const rows = await transaction.select({
      count: sql<number>`count(*)`,
      status: collaborationRoomClosureJobs.status,
    }).from(collaborationRoomClosureJobs).groupBy(collaborationRoomClosureJobs.status);
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    return {
      exhausted: counts.get("exhausted") ?? 0,
      pending: counts.get("pending") ?? 0,
    };
  }));

  return { archive, reconcileDueRoomClosures };
}

function retryDelay(attempts: number) {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
}

function normalizeBatchLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_RECONCILE_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE_BATCH) {
    throw new DocumentArchiveServiceError("invalid_input");
  }
  return limit;
}

function validateScope(scope: WorkspaceScope, documentId: string) {
  validateIdentifier(scope.workspaceId);
  validateIdentifier(documentId);
}

function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || CONTROL_CHARACTERS.test(value)
    || BOUNDARY_WHITESPACE.test(value)
  ) {
    throw new DocumentArchiveServiceError("invalid_input");
  }
}

function readTimestamp(now: () => Date) {
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isSafeInteger(timestamp.valueOf())) {
    throw new DocumentArchiveServiceError("unavailable");
  }
  return timestamp;
}

async function storage<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DocumentArchiveServiceError) throw error;
    throw new DocumentArchiveServiceError("unavailable");
  }
}
