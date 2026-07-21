import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  collaborationActions,
  collaborationCommandDeliveryJobs,
  collaborationDocuments,
  collaborationUpdates,
  documents,
} from "@/db/schema";

import { createCollaborationCommandDeliveryOutbox } from "./command-delivery-outbox";
import { createCollaborationRepository } from "./repository";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const clients: Client[] = [];
const tempDirs: string[] = [];
const HASH = "a".repeat(64);
const COMMAND_FINGERPRINT = "b".repeat(64);

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration command delivery outbox", () => {
  it("publishes the exact durable semantic update and removes its action job", async () => {
    const harness = await createHarness("exact-delivery");
    const update = Uint8Array.from([1, 2, 3, 4]);
    await seedSemanticUpdate(harness.database, update);
    const publishDurableUpdate = vi.fn();
    const outbox = createCollaborationCommandDeliveryOutbox({
      database: harness.database,
      gateway: { publishDurableUpdate },
      now: () => new Date(1_000),
    });
    const repository = createCollaborationRepository(harness.database);

    await repository.write((transaction) => outbox.enqueue(transaction, {
      actionId: "action-a",
      checksum: sha256(update),
      commandFingerprint: COMMAND_FINGERPRINT,
      commandId: "command-a",
      documentId: "document-a",
      generation: 1,
      seq: 1,
      timestamp: new Date(1_000),
      workspaceId: "workspace-a",
    }));

    await expect(outbox.reconcileDue()).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      exhausted: 0,
      pending: 0,
    });
    expect(publishDurableUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
      update,
    );
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([]);
  });

  it("treats an unloaded room as delivered when the sidecar accepts the publication", async () => {
    const harness = await createHarness("unloaded-room");
    const update = Uint8Array.from([5, 6, 7]);
    await seedSemanticUpdate(harness.database, update);
    const outbox = createCollaborationCommandDeliveryOutbox({
      database: harness.database,
      gateway: { async publishDurableUpdate() {} },
      now: () => new Date(1_000),
    });
    const repository = createCollaborationRepository(harness.database);
    await repository.write((transaction) => outbox.enqueue(transaction, deliveryInput(update)));

    await expect(outbox.reconcileDue()).resolves.toMatchObject({ delivered: 1, pending: 0 });
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([]);
  });

  it("exhausts bounded retries without storing private gateway failure details", async () => {
    const harness = await createHarness("bounded-retry");
    const update = Uint8Array.from([8, 9]);
    await seedSemanticUpdate(harness.database, update);
    let now = new Date(1_000);
    const publishDurableUpdate = vi.fn(async () => {
      throw new Error("private sidecar credential");
    });
    const outbox = createCollaborationCommandDeliveryOutbox({
      database: harness.database,
      gateway: { publishDurableUpdate },
      now: () => now,
    });
    const repository = createCollaborationRepository(harness.database);
    await repository.write((transaction) => outbox.enqueue(transaction, deliveryInput(update)));

    for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
      now = new Date(now.valueOf() + delay);
      await outbox.reconcileDue();
    }

    const [job] = await harness.database.select().from(collaborationCommandDeliveryJobs);
    expect(job).toMatchObject({
      actionId: "action-a",
      attempts: 5,
      failureCategory: "delivery_failed",
      nextAttemptAt: null,
      status: "exhausted",
    });
    expect(JSON.stringify(job)).not.toContain("private sidecar credential");
    expect(publishDurableUpdate).toHaveBeenCalledTimes(5);
  });

  it("re-arms an exact exhausted delivery only when the semantic command is replayed", async () => {
    const harness = await createHarness("explicit-redrive");
    const update = Uint8Array.from([8, 9]);
    await seedSemanticUpdate(harness.database, update);
    let now = new Date(1_000);
    const outbox = createCollaborationCommandDeliveryOutbox({
      database: harness.database,
      gateway: { async publishDurableUpdate() { throw new Error("offline"); } },
      now: () => now,
    });
    const repository = createCollaborationRepository(harness.database);
    const input = deliveryInput(update);
    await repository.write((transaction) => outbox.enqueue(transaction, input));
    for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
      now = new Date(now.valueOf() + delay);
      await outbox.reconcileDue();
    }

    const redriveAt = new Date(30_000);
    await expect(repository.write((transaction) => outbox.enqueue(transaction, {
      ...input,
      timestamp: redriveAt,
    }))).resolves.toMatchObject({ attempts: 0 });
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({
        attempts: 0,
        failureCategory: null,
        nextAttemptAt: redriveAt,
        status: "pending",
        updatedAt: redriveAt,
      }),
    ]);
  });

  it("prevents compaction from deleting an update while its delivery is pending", async () => {
    const harness = await createHarness("pending-retention");
    const update = Uint8Array.from([12, 13]);
    await seedSemanticUpdate(harness.database, update);
    const outbox = createCollaborationCommandDeliveryOutbox({ database: harness.database });
    const repository = createCollaborationRepository(harness.database);
    await repository.write((transaction) => outbox.enqueue(transaction, deliveryInput(update)));

    await expect(harness.database.delete(collaborationUpdates)).rejects.toThrow();
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(1);
  });

  it("fails closed instead of publishing a blob whose content does not match its checksum", async () => {
    const harness = await createHarness("checksum-fence");
    const update = Uint8Array.from([10, 11]);
    await seedSemanticUpdate(harness.database, update);
    const publishDurableUpdate = vi.fn();
    const outbox = createCollaborationCommandDeliveryOutbox({
      database: harness.database,
      gateway: { publishDurableUpdate },
      now: () => new Date(1_000),
    });
    const repository = createCollaborationRepository(harness.database);
    await repository.write((transaction) => outbox.enqueue(transaction, deliveryInput(update)));
    await harness.database.update(collaborationUpdates).set({ updateBlob: Buffer.from([99]) });

    await expect(outbox.reconcileDue()).resolves.toMatchObject({ attempted: 1, delivered: 0, pending: 1 });
    expect(publishDurableUpdate).not.toHaveBeenCalled();
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({ attempts: 1, failureCategory: "delivery_failed" }),
    ]);
  });
});

function deliveryInput(update: Uint8Array) {
  return {
    actionId: "action-a",
    checksum: sha256(update),
    commandFingerprint: COMMAND_FINGERPRINT,
    commandId: "command-a",
    documentId: "document-a",
    generation: 1,
    seq: 1,
    timestamp: new Date(1_000),
    workspaceId: "workspace-a",
  };
}

async function createHarness(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-command-delivery-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "outbox.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  return { database };
}

async function seedSemanticUpdate(
  database: Awaited<ReturnType<typeof createHarness>>["database"],
  update: Uint8Array,
) {
  const timestamp = new Date(1_000);
  await database.insert(documents).values({
    contentJson: { type: "doc" },
    createdAt: timestamp,
    id: "document-a",
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    status: "draft",
    title: "Command fixture",
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  await database.insert(collaborationDocuments).values({
    checkpointBlob: Buffer.from([0]),
    checkpointChecksum: HASH,
    checkpointSeq: 0,
    createdAt: timestamp,
    documentId: "document-a",
    generation: 1,
    headSeq: 1,
    isCurrent: true,
    lastCheckpointAt: timestamp,
    projectedSeq: 0,
    schemaFingerprint: HASH,
    schemaVersion: 1,
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  await database.insert(collaborationActions).values({
    actionType: "proposal_apply",
    appliedHeadSeq: 1,
    baseHeadSeq: 0,
    commandId: "command-a",
    commandFingerprint: COMMAND_FINGERPRINT,
    createdAt: timestamp,
    documentId: "document-a",
    generation: 1,
    id: "action-a",
    principalId: "principal-a",
    requestId: "request-a",
    status: "applied",
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  await database.insert(collaborationUpdates).values({
    checksum: sha256(update),
    createdAt: timestamp,
    documentId: "document-a",
    generation: 1,
    idempotencyKey: "command-a",
    originKind: "proposal_command",
    principalId: "principal-a",
    requestId: "request-a",
    semanticActionId: "action-a",
    seq: 1,
    updateBlob: Buffer.from(update),
    workspaceId: "workspace-a",
  });
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
