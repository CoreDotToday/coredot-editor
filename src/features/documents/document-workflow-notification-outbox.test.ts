import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  collaborationDocuments,
  collaborationWorkflowNotificationJobs,
  documents,
} from "@/db/schema";
import { createCollaborationRepository } from "@/features/collaboration/repository";

import {
  createDocumentWorkflowNotificationOutbox,
  DocumentWorkflowNotificationOutboxError,
} from "./document-workflow-notification-outbox";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const clients: Client[] = [];
const tempDirs: string[] = [];
const HASH = "a".repeat(64);

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("document workflow notification outbox", () => {
  it("keeps a newer coalesced workflow revision when an older delivery finishes", async () => {
    const harness = await createHarness("revision-fence");
    await seedDocument(harness.database, "document-a");
    const repository = createCollaborationRepository(harness.database);
    let now = new Date(1_000);
    const outboxRef: {
      current?: ReturnType<typeof createDocumentWorkflowNotificationOutbox>;
    } = {};
    const outbox = createDocumentWorkflowNotificationOutbox({
      database: harness.database,
      gateway: {
        async notifyWorkflowChanged() {
          now = new Date(2_000);
          const current = outboxRef.current;
          if (!current) throw new Error("expected outbox");
          await repository.write((transaction) => current.enqueue(transaction, {
            documentId: "document-a",
            generation: 1,
            timestamp: now,
            workflowRevision: 2,
            workspaceId: "workspace-a",
          }));
        },
      },
      now: () => now,
    });
    outboxRef.current = outbox;
    const first = await repository.write((transaction) => outbox.enqueue(transaction, {
      documentId: "document-a",
      generation: 1,
      timestamp: now,
      workflowRevision: 1,
      workspaceId: "workspace-a",
    }));

    await expect(outbox.deliver(first)).resolves.toBe("pending");

    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([
      expect.objectContaining({
        attempts: 0,
        generation: 1,
        status: "pending",
        workflowRevision: 2,
      }),
    ]);
  });

  it("replaces an exhausted older generation instead of accumulating one row per rotation", async () => {
    const harness = await createHarness("generation-coalesce");
    await seedDocument(harness.database, "document-a");
    const [generationOne] = await harness.database.select().from(collaborationDocuments);
    if (!generationOne) throw new Error("expected collaboration generation");
    await harness.database.insert(collaborationDocuments).values({
      ...generationOne,
      generation: 2,
      isCurrent: false,
    });
    const repository = createCollaborationRepository(harness.database);
    const outbox = createDocumentWorkflowNotificationOutbox({ database: harness.database });
    await repository.write((transaction) => outbox.enqueue(transaction, {
      documentId: "document-a",
      generation: 1,
      timestamp: new Date(1_000),
      workflowRevision: 1,
      workspaceId: "workspace-a",
    }));
    await harness.database.update(collaborationWorkflowNotificationJobs).set({
      attempts: 5,
      failureCategory: "delivery_failed",
      nextAttemptAt: null,
      status: "exhausted",
    });

    await repository.write((transaction) => outbox.enqueue(transaction, {
      documentId: "document-a",
      generation: 2,
      timestamp: new Date(2_000),
      workflowRevision: 2,
      workspaceId: "workspace-a",
    }));

    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([
      expect.objectContaining({
        attempts: 0,
        failureCategory: null,
        generation: 2,
        status: "pending",
        workflowRevision: 2,
      }),
    ]);
  });

  it("reconciles only a bounded due batch and publishes each exact generation", async () => {
    const harness = await createHarness("bounded-batch");
    const repository = createCollaborationRepository(harness.database);
    const notifyWorkflowChanged = vi.fn();
    const outbox = createDocumentWorkflowNotificationOutbox({
      database: harness.database,
      gateway: { notifyWorkflowChanged },
      now: () => new Date(1_000),
    });
    for (const documentId of ["document-a", "document-b"]) {
      await seedDocument(harness.database, documentId);
      await repository.write((transaction) => outbox.enqueue(transaction, {
        documentId,
        generation: 1,
        timestamp: new Date(1_000),
        workflowRevision: 1,
        workspaceId: "workspace-a",
      }));
    }

    await expect(outbox.reconcileDue({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      exhausted: 0,
      pending: 1,
    });
    expect(notifyWorkflowChanged).toHaveBeenCalledWith(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
    );
  });

  it("exhausts bounded retries without storing gateway details", async () => {
    const harness = await createHarness("retry-bound");
    await seedDocument(harness.database, "document-a");
    const repository = createCollaborationRepository(harness.database);
    let now = new Date(1_000);
    const notifyWorkflowChanged = vi.fn(async () => {
      throw new Error("private stateless transport token");
    });
    const outbox = createDocumentWorkflowNotificationOutbox({
      database: harness.database,
      gateway: { notifyWorkflowChanged },
      now: () => now,
    });
    await repository.write((transaction) => outbox.enqueue(transaction, {
      documentId: "document-a",
      generation: 1,
      timestamp: now,
      workflowRevision: 1,
      workspaceId: "workspace-a",
    }));

    for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
      now = new Date(now.valueOf() + delay);
      await outbox.reconcileDue();
    }

    const [job] = await harness.database.select().from(collaborationWorkflowNotificationJobs);
    expect(job).toMatchObject({
      attempts: 5,
      failureCategory: "delivery_failed",
      nextAttemptAt: null,
      status: "exhausted",
    });
    expect(JSON.stringify(job)).not.toContain("private stateless transport token");
    now = new Date(now.valueOf() + 86_400_000);
    await expect(outbox.reconcileDue()).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      exhausted: 1,
      pending: 0,
    });
    expect(notifyWorkflowChanged).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid batch limits with a bounded content-free error", async () => {
    const harness = await createHarness("invalid-limit");
    const outbox = createDocumentWorkflowNotificationOutbox({ database: harness.database });
    const failure = await outbox.reconcileDue({ limit: 51 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DocumentWorkflowNotificationOutboxError);
    expect(failure).toMatchObject({ category: "invalid_input" });
    expect(String(failure)).not.toContain("51");
  });
});

async function createHarness(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-workflow-outbox-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "outbox.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  return { database };
}

async function seedDocument(
  database: Awaited<ReturnType<typeof createHarness>>["database"],
  documentId: string,
) {
  const timestamp = new Date(1_000);
  await database.insert(documents).values({
    contentJson: { type: "doc" },
    createdAt: timestamp,
    id: documentId,
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    status: "draft",
    title: "Workflow fixture",
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  await database.insert(collaborationDocuments).values({
    checkpointBlob: Buffer.from([0]),
    checkpointChecksum: HASH,
    checkpointSeq: 0,
    createdAt: timestamp,
    documentId,
    generation: 1,
    headSeq: 0,
    isCurrent: true,
    lastCheckpointAt: timestamp,
    projectedSeq: 0,
    schemaFingerprint: HASH,
    schemaVersion: 1,
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  await database.update(documents).set({ revision: 1 }).where(eq(documents.id, documentId));
}
