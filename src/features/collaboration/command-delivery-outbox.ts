import { createHash } from "node:crypto";

import { and, asc, eq, lte, sql } from "drizzle-orm";

import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  COLLABORATION_COMMAND_DELIVERY_MAX_ATTEMPTS,
  collaborationCommandDeliveryJobs,
  collaborationUpdates,
  type CollaborationCommandDeliveryJobRecord,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";

import {
  createCollaborationRepository,
  type CollaborationDatabase,
  type CollaborationTransaction,
} from "./repository";

const DEFAULT_RECONCILE_BATCH = 25;
const MAX_RECONCILE_BATCH = 50;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface CollaborationCommandDeliveryGateway {
  publishDurableUpdate(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
    update: Uint8Array,
  ): Promise<void>;
}

export type CollaborationCommandDelivery = {
  actionId: string;
  attempts: number;
  checksum: string;
  commandFingerprint: string;
  commandId: string;
  documentId: string;
  generation: number;
  seq: number;
  workspaceId: string;
};

export type CollaborationCommandDeliveryEnqueueInput = {
  actionId: string;
  checksum: string;
  commandFingerprint: string;
  commandId: string;
  documentId: string;
  generation: number;
  seq: number;
  timestamp: Date;
  workspaceId: string;
};

export type CollaborationCommandDeliveryReconciliation = {
  attempted: number;
  delivered: number;
  exhausted: number;
  pending: number;
};

export class CollaborationCommandDeliveryOutboxError extends Error {
  override readonly name = "CollaborationCommandDeliveryOutboxError";

  constructor(readonly category: "invalid_input" | "unavailable") {
    super(category === "invalid_input"
      ? "Collaboration command delivery is invalid"
      : "Collaboration command delivery service is unavailable");
  }
}

export function createCollaborationCommandDeliveryOutbox(options: {
  database: CollaborationDatabase;
  gateway?: CollaborationCommandDeliveryGateway;
  now?: () => Date;
}) {
  const repository = createCollaborationRepository(options.database);
  const now = options.now ?? (() => new Date());

  const enqueue = async (
    transaction: CollaborationTransaction,
    input: CollaborationCommandDeliveryEnqueueInput,
  ): Promise<CollaborationCommandDelivery> => {
    validateEnqueueInput(input);
    const inserted = await transaction.insert(collaborationCommandDeliveryJobs).values({
      actionId: input.actionId,
      attempts: 0,
      checksum: input.checksum,
      commandFingerprint: input.commandFingerprint,
      commandId: input.commandId,
      createdAt: input.timestamp,
      documentId: input.documentId,
      failureCategory: null,
      generation: input.generation,
      nextAttemptAt: input.timestamp,
      seq: input.seq,
      status: "pending",
      updatedAt: input.timestamp,
      workspaceId: input.workspaceId,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return toDelivery(inserted[0]);

    const [existing] = await transaction.select().from(collaborationCommandDeliveryJobs).where(and(
      eq(collaborationCommandDeliveryJobs.workspaceId, input.workspaceId),
      eq(collaborationCommandDeliveryJobs.actionId, input.actionId),
    )).limit(1);
    if (!existing || !matchesInput(existing, input)) {
      throw new CollaborationCommandDeliveryOutboxError("invalid_input");
    }
    if (existing.status === "exhausted") {
      if (input.timestamp < existing.createdAt) {
        throw new CollaborationCommandDeliveryOutboxError("invalid_input");
      }
      const [rearmed] = await transaction.update(collaborationCommandDeliveryJobs).set({
        attempts: 0,
        failureCategory: null,
        nextAttemptAt: input.timestamp,
        status: "pending",
        updatedAt: input.timestamp,
      }).where(and(
        eq(collaborationCommandDeliveryJobs.workspaceId, existing.workspaceId),
        eq(collaborationCommandDeliveryJobs.actionId, existing.actionId),
        eq(collaborationCommandDeliveryJobs.commandId, existing.commandId),
        eq(collaborationCommandDeliveryJobs.commandFingerprint, existing.commandFingerprint),
        eq(collaborationCommandDeliveryJobs.documentId, existing.documentId),
        eq(collaborationCommandDeliveryJobs.generation, existing.generation),
        eq(collaborationCommandDeliveryJobs.seq, existing.seq),
        eq(collaborationCommandDeliveryJobs.checksum, existing.checksum),
        eq(collaborationCommandDeliveryJobs.status, "exhausted"),
        eq(collaborationCommandDeliveryJobs.attempts, COLLABORATION_COMMAND_DELIVERY_MAX_ATTEMPTS),
        eq(collaborationCommandDeliveryJobs.updatedAt, existing.updatedAt),
      )).returning();
      if (!rearmed) throw new CollaborationCommandDeliveryOutboxError("unavailable");
      return toDelivery(rearmed);
    }
    return toDelivery(existing);
  };

  const deliver = async (
    delivery: CollaborationCommandDelivery,
  ): Promise<"delivered" | "pending"> => {
    if (!options.gateway) return "pending";
    const update = await readExactUpdate(delivery);
    if (!update || checksum(update) !== delivery.checksum) {
      await recordDeliveryFailure(delivery);
      return "pending";
    }

    try {
      await options.gateway.publishDurableUpdate(
        { workspaceId: delivery.workspaceId },
        delivery.documentId,
        delivery.generation,
        update,
      );
    } catch {
      await recordDeliveryFailure(delivery);
      return "pending";
    }

    const deleted = await storage(async () => repository.write((transaction) => transaction
      .delete(collaborationCommandDeliveryJobs)
      .where(deliveryFence(delivery))
      .returning({ actionId: collaborationCommandDeliveryJobs.actionId })));
    return deleted.length === 1 ? "delivered" : "pending";
  };

  const recordDeliveryFailure = async (delivery: CollaborationCommandDelivery) => {
    const nextAttempts = delivery.attempts + 1;
    const exhausted = nextAttempts >= COLLABORATION_COMMAND_DELIVERY_MAX_ATTEMPTS;
    const timestamp = readTimestamp(now);
    await storage(async () => repository.write((transaction) => transaction
      .update(collaborationCommandDeliveryJobs)
      .set({
        attempts: nextAttempts,
        failureCategory: "delivery_failed",
        nextAttemptAt: exhausted
          ? null
          : new Date(timestamp.valueOf() + retryDelay(nextAttempts)),
        status: exhausted ? "exhausted" : "pending",
        updatedAt: timestamp,
      })
      .where(deliveryFence(delivery))));
  };

  const readExactUpdate = async (delivery: CollaborationCommandDelivery) => storage(async () =>
    repository.read(async (transaction) => {
      const [stored] = await transaction.select({
        semanticActionId: collaborationUpdates.semanticActionId,
        updateBlob: collaborationUpdates.updateBlob,
      }).from(collaborationUpdates).where(and(
        eq(collaborationUpdates.workspaceId, delivery.workspaceId),
        eq(collaborationUpdates.documentId, delivery.documentId),
        eq(collaborationUpdates.generation, delivery.generation),
        eq(collaborationUpdates.seq, delivery.seq),
        eq(collaborationUpdates.checksum, delivery.checksum),
        eq(collaborationUpdates.semanticActionId, delivery.actionId),
      )).limit(1);
      return stored
        ? new Uint8Array(stored.updateBlob)
        : null;
    }));

  const reconcileDue = async (
    input: { limit?: number } = {},
  ): Promise<CollaborationCommandDeliveryReconciliation> => {
    const limit = normalizeBatchLimit(input.limit);
    const startedAt = readTimestamp(now);
    const jobs = await storage(async () => repository.read((transaction) => transaction
      .select()
      .from(collaborationCommandDeliveryJobs)
      .where(and(
        eq(collaborationCommandDeliveryJobs.status, "pending"),
        lte(collaborationCommandDeliveryJobs.nextAttemptAt, startedAt),
      ))
      .orderBy(
        asc(collaborationCommandDeliveryJobs.nextAttemptAt),
        asc(collaborationCommandDeliveryJobs.createdAt),
        asc(collaborationCommandDeliveryJobs.workspaceId),
        asc(collaborationCommandDeliveryJobs.documentId),
        asc(collaborationCommandDeliveryJobs.generation),
        asc(collaborationCommandDeliveryJobs.seq),
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
    candidate: CollaborationCommandDeliveryJobRecord,
    dueAt: Date,
  ) => storage(async () => repository.read(async (transaction) => {
    const [job] = await transaction.select().from(collaborationCommandDeliveryJobs).where(and(
      eq(collaborationCommandDeliveryJobs.workspaceId, candidate.workspaceId),
      eq(collaborationCommandDeliveryJobs.actionId, candidate.actionId),
      eq(collaborationCommandDeliveryJobs.commandFingerprint, candidate.commandFingerprint),
      eq(collaborationCommandDeliveryJobs.documentId, candidate.documentId),
      eq(collaborationCommandDeliveryJobs.generation, candidate.generation),
      eq(collaborationCommandDeliveryJobs.seq, candidate.seq),
      eq(collaborationCommandDeliveryJobs.checksum, candidate.checksum),
      eq(collaborationCommandDeliveryJobs.status, "pending"),
      eq(collaborationCommandDeliveryJobs.attempts, candidate.attempts),
      lte(collaborationCommandDeliveryJobs.nextAttemptAt, dueAt),
    )).limit(1);
    return job ?? null;
  }));

  const readJobCounts = async () => storage(async () => repository.read(async (transaction) => {
    const rows = await transaction.select({
      count: sql<number>`count(*)`,
      status: collaborationCommandDeliveryJobs.status,
    }).from(collaborationCommandDeliveryJobs).groupBy(collaborationCommandDeliveryJobs.status);
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    return {
      exhausted: counts.get("exhausted") ?? 0,
      pending: counts.get("pending") ?? 0,
    };
  }));

  return { deliver, enqueue, reconcileDue };
}

function deliveryFence(delivery: CollaborationCommandDelivery) {
  return and(
    eq(collaborationCommandDeliveryJobs.workspaceId, delivery.workspaceId),
    eq(collaborationCommandDeliveryJobs.actionId, delivery.actionId),
    eq(collaborationCommandDeliveryJobs.commandId, delivery.commandId),
    eq(collaborationCommandDeliveryJobs.commandFingerprint, delivery.commandFingerprint),
    eq(collaborationCommandDeliveryJobs.documentId, delivery.documentId),
    eq(collaborationCommandDeliveryJobs.generation, delivery.generation),
    eq(collaborationCommandDeliveryJobs.seq, delivery.seq),
    eq(collaborationCommandDeliveryJobs.checksum, delivery.checksum),
    eq(collaborationCommandDeliveryJobs.status, "pending"),
    eq(collaborationCommandDeliveryJobs.attempts, delivery.attempts),
  );
}

function toDelivery(job: CollaborationCommandDeliveryJobRecord): CollaborationCommandDelivery {
  return {
    actionId: job.actionId,
    attempts: job.attempts,
    checksum: job.checksum,
    commandFingerprint: job.commandFingerprint,
    commandId: job.commandId,
    documentId: job.documentId,
    generation: job.generation,
    seq: job.seq,
    workspaceId: job.workspaceId,
  };
}

function matchesInput(
  job: CollaborationCommandDeliveryJobRecord,
  input: CollaborationCommandDeliveryEnqueueInput,
) {
  return job.commandId === input.commandId
    && job.commandFingerprint === input.commandFingerprint
    && job.documentId === input.documentId
    && job.generation === input.generation
    && job.seq === input.seq
    && job.checksum === input.checksum;
}

function validateEnqueueInput(input: CollaborationCommandDeliveryEnqueueInput) {
  if (
    !input.actionId
    || !input.commandId
    || !input.documentId
    || !input.workspaceId
    || !SHA256_PATTERN.test(input.checksum)
    || !SHA256_PATTERN.test(input.commandFingerprint)
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || !Number.isSafeInteger(input.seq)
    || input.seq < 1
    || !(input.timestamp instanceof Date)
    || !Number.isSafeInteger(input.timestamp.valueOf())
  ) {
    throw new CollaborationCommandDeliveryOutboxError("invalid_input");
  }
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function retryDelay(attempts: number) {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
}

function normalizeBatchLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_RECONCILE_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE_BATCH) {
    throw new CollaborationCommandDeliveryOutboxError("invalid_input");
  }
  return limit;
}

function readTimestamp(now: () => Date) {
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isSafeInteger(timestamp.valueOf())) {
    throw new CollaborationCommandDeliveryOutboxError("unavailable");
  }
  return timestamp;
}

async function storage<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CollaborationCommandDeliveryOutboxError) throw error;
    throw new CollaborationCommandDeliveryOutboxError("unavailable");
  }
}
