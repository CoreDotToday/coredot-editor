import { and, asc, eq, lte, sql } from "drizzle-orm";

import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  COLLABORATION_WORKFLOW_NOTIFICATION_MAX_ATTEMPTS,
  collaborationWorkflowNotificationJobs,
  type CollaborationWorkflowNotificationJobRecord,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import {
  createCollaborationRepository,
  type CollaborationDatabase,
  type CollaborationTransaction,
} from "@/features/collaboration/repository";

const DEFAULT_RECONCILE_BATCH = 25;
const MAX_RECONCILE_BATCH = 50;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;

export interface DocumentWorkflowNotificationGateway {
  notifyWorkflowChanged(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ): Promise<void>;
}

export type DocumentWorkflowNotificationDelivery = {
  attempts: number;
  documentId: string;
  generation: number;
  workflowRevision: number;
  workspaceId: string;
};

export type DocumentWorkflowNotificationReconciliation = {
  attempted: number;
  delivered: number;
  exhausted: number;
  pending: number;
};

export class DocumentWorkflowNotificationOutboxError extends Error {
  override readonly name = "DocumentWorkflowNotificationOutboxError";

  constructor(readonly category: "invalid_input" | "unavailable") {
    super(category === "invalid_input"
      ? "Document workflow notification command is invalid"
      : "Document workflow notification service is unavailable");
  }
}

export function createDocumentWorkflowNotificationOutbox(options: {
  database: CollaborationDatabase;
  gateway?: DocumentWorkflowNotificationGateway;
  now?: () => Date;
}) {
  const repository = createCollaborationRepository(options.database);
  const now = options.now ?? (() => new Date());

  const enqueue = async (
    transaction: CollaborationTransaction,
    input: {
      documentId: string;
      generation: number;
      timestamp: Date;
      workflowRevision: number;
      workspaceId: string;
    },
  ): Promise<DocumentWorkflowNotificationDelivery> => {
    await transaction.insert(collaborationWorkflowNotificationJobs).values({
      attempts: 0,
      createdAt: input.timestamp,
      documentId: input.documentId,
      failureCategory: null,
      generation: input.generation,
      nextAttemptAt: input.timestamp,
      status: "pending",
      updatedAt: input.timestamp,
      workflowRevision: input.workflowRevision,
      workspaceId: input.workspaceId,
    }).onConflictDoUpdate({
      set: {
        attempts: 0,
        failureCategory: null,
        generation: input.generation,
        nextAttemptAt: input.timestamp,
        status: "pending",
        updatedAt: input.timestamp,
        workflowRevision: input.workflowRevision,
      },
      target: [
        collaborationWorkflowNotificationJobs.workspaceId,
        collaborationWorkflowNotificationJobs.documentId,
      ],
    });
    return {
      attempts: 0,
      documentId: input.documentId,
      generation: input.generation,
      workflowRevision: input.workflowRevision,
      workspaceId: input.workspaceId,
    };
  };

  const deliver = async (
    delivery: DocumentWorkflowNotificationDelivery,
  ): Promise<"delivered" | "pending"> => {
    if (!options.gateway) return "pending";
    try {
      await options.gateway.notifyWorkflowChanged(
        { workspaceId: delivery.workspaceId },
        delivery.documentId,
        delivery.generation,
      );
    } catch {
      await recordDeliveryFailure(delivery);
      return "pending";
    }

    const deleted = await storage(async () => repository.write((transaction) => transaction
      .delete(collaborationWorkflowNotificationJobs)
      .where(and(
        eq(collaborationWorkflowNotificationJobs.workspaceId, delivery.workspaceId),
        eq(collaborationWorkflowNotificationJobs.documentId, delivery.documentId),
        eq(collaborationWorkflowNotificationJobs.generation, delivery.generation),
        eq(collaborationWorkflowNotificationJobs.workflowRevision, delivery.workflowRevision),
        eq(collaborationWorkflowNotificationJobs.status, "pending"),
        eq(collaborationWorkflowNotificationJobs.attempts, delivery.attempts),
      ))
      .returning({ documentId: collaborationWorkflowNotificationJobs.documentId })));
    return deleted.length === 1 ? "delivered" : "pending";
  };

  const recordDeliveryFailure = async (delivery: DocumentWorkflowNotificationDelivery) => {
    const nextAttempts = delivery.attempts + 1;
    const exhausted = nextAttempts >= COLLABORATION_WORKFLOW_NOTIFICATION_MAX_ATTEMPTS;
    const timestamp = readTimestamp(now);
    await storage(async () => repository.write((transaction) => transaction
      .update(collaborationWorkflowNotificationJobs)
      .set({
        attempts: nextAttempts,
        failureCategory: "delivery_failed",
        nextAttemptAt: exhausted
          ? null
          : new Date(timestamp.valueOf() + retryDelay(nextAttempts)),
        status: exhausted ? "exhausted" : "pending",
        updatedAt: timestamp,
      })
      .where(and(
        eq(collaborationWorkflowNotificationJobs.workspaceId, delivery.workspaceId),
        eq(collaborationWorkflowNotificationJobs.documentId, delivery.documentId),
        eq(collaborationWorkflowNotificationJobs.generation, delivery.generation),
        eq(collaborationWorkflowNotificationJobs.workflowRevision, delivery.workflowRevision),
        eq(collaborationWorkflowNotificationJobs.status, "pending"),
        eq(collaborationWorkflowNotificationJobs.attempts, delivery.attempts),
      ))));
  };

  const reconcileDue = async (
    input: { limit?: number } = {},
  ): Promise<DocumentWorkflowNotificationReconciliation> => {
    const limit = normalizeBatchLimit(input.limit);
    const startedAt = readTimestamp(now);
    const jobs = await storage(async () => repository.read((transaction) => transaction
      .select()
      .from(collaborationWorkflowNotificationJobs)
      .where(and(
        eq(collaborationWorkflowNotificationJobs.status, "pending"),
        lte(collaborationWorkflowNotificationJobs.nextAttemptAt, startedAt),
      ))
      .orderBy(
        asc(collaborationWorkflowNotificationJobs.nextAttemptAt),
        asc(collaborationWorkflowNotificationJobs.createdAt),
        asc(collaborationWorkflowNotificationJobs.workspaceId),
        asc(collaborationWorkflowNotificationJobs.documentId),
        asc(collaborationWorkflowNotificationJobs.generation),
      )
      .limit(limit)));

    let attempted = 0;
    let delivered = 0;
    for (const candidate of jobs) {
      const outcome = await withSerializedDocumentWrite(
        { workspaceId: candidate.workspaceId },
        candidate.documentId,
        async () => {
          const current = await readDueJob(candidate, startedAt);
          if (!current) return "skipped" as const;
          return deliver(toDelivery(current));
        },
      );
      if (outcome === "skipped") continue;
      attempted += 1;
      if (outcome === "delivered") delivered += 1;
    }

    return { attempted, delivered, ...await readJobCounts() };
  };

  const readDueJob = async (
    candidate: CollaborationWorkflowNotificationJobRecord,
    dueAt: Date,
  ) => storage(async () => repository.read(async (transaction) => {
    const [job] = await transaction.select().from(collaborationWorkflowNotificationJobs)
      .where(and(
        eq(collaborationWorkflowNotificationJobs.workspaceId, candidate.workspaceId),
        eq(collaborationWorkflowNotificationJobs.documentId, candidate.documentId),
        eq(collaborationWorkflowNotificationJobs.generation, candidate.generation),
        eq(collaborationWorkflowNotificationJobs.workflowRevision, candidate.workflowRevision),
        eq(collaborationWorkflowNotificationJobs.status, "pending"),
        eq(collaborationWorkflowNotificationJobs.attempts, candidate.attempts),
        lte(collaborationWorkflowNotificationJobs.nextAttemptAt, dueAt),
      ))
      .limit(1);
    return job ?? null;
  }));

  const readJobCounts = async () => storage(async () => repository.read(async (transaction) => {
    const rows = await transaction.select({
      count: sql<number>`count(*)`,
      status: collaborationWorkflowNotificationJobs.status,
    }).from(collaborationWorkflowNotificationJobs)
      .groupBy(collaborationWorkflowNotificationJobs.status);
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    return {
      exhausted: counts.get("exhausted") ?? 0,
      pending: counts.get("pending") ?? 0,
    };
  }));

  return { deliver, enqueue, reconcileDue };
}

function toDelivery(job: CollaborationWorkflowNotificationJobRecord): DocumentWorkflowNotificationDelivery {
  return {
    attempts: job.attempts,
    documentId: job.documentId,
    generation: job.generation,
    workflowRevision: job.workflowRevision,
    workspaceId: job.workspaceId,
  };
}

function retryDelay(attempts: number) {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
}

function normalizeBatchLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_RECONCILE_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE_BATCH) {
    throw new DocumentWorkflowNotificationOutboxError("invalid_input");
  }
  return limit;
}

function readTimestamp(now: () => Date) {
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isSafeInteger(timestamp.valueOf())) {
    throw new DocumentWorkflowNotificationOutboxError("unavailable");
  }
  return timestamp;
}

async function storage<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DocumentWorkflowNotificationOutboxError) throw error;
    throw new DocumentWorkflowNotificationOutboxError("unavailable");
  }
}
