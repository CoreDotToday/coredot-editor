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
  collaborationRoomClosureJobs,
  documents,
} from "@/db/schema";
import {
  createDocumentArchiveService,
  DocumentArchiveServiceError,
} from "./document-archive-service";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const clients: Client[] = [];
const tempDirs: string[] = [];
const scopeA = { workspaceId: "workspace-a" };
const scopeB = { workspaceId: "workspace-b" };
const HASH = "a".repeat(64);

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("document archive service", () => {
  it("commits a collaborative archive and its non-content closure job before delivery", async () => {
    const harness = await createHarness("commit-first");
    await seedDocument(harness.database, "document-a", scopeA.workspaceId, true);
    const closeRoom = vi.fn(async () => {
      const [document] = await harness.database.select({ status: documents.status })
        .from(documents)
        .where(eq(documents.id, "document-a"));
      const jobs = await harness.database.select().from(collaborationRoomClosureJobs);

      expect(document?.status).toBe("archived");
      expect(jobs).toEqual([
        expect.objectContaining({
          attempts: 0,
          documentId: "document-a",
          generation: 1,
          reason: "archived",
          status: "pending",
          workspaceId: scopeA.workspaceId,
        }),
      ]);
    });
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: closeRoom },
      now: () => new Date("2027-01-15T08:00:00.000Z"),
    });

    await expect(service.archive(scopeA, "document-a")).resolves.toEqual({
      roomClosure: "delivered",
      status: "archived",
    });
    expect(closeRoom).toHaveBeenCalledWith(scopeA, "document-a", 1);
    await expect(harness.database.select().from(collaborationRoomClosureJobs)).resolves.toEqual([]);
  });

  it("archives a legacy document without creating or delivering a pointless room job", async () => {
    const harness = await createHarness("legacy");
    await seedDocument(harness.database, "legacy-document", scopeA.workspaceId, false);
    const closeRoom = vi.fn();
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: closeRoom },
    });

    await expect(service.archive(scopeA, "legacy-document")).resolves.toEqual({
      roomClosure: "not_required",
      status: "archived",
    });
    expect(closeRoom).not.toHaveBeenCalled();
    await expect(harness.database.select().from(collaborationRoomClosureJobs)).resolves.toEqual([]);
  });

  it("keeps the archive committed and records only a bounded failure category when delivery fails", async () => {
    const harness = await createHarness("delivery-failure");
    await seedDocument(harness.database, "document-a", scopeA.workspaceId, true);
    const now = new Date("2027-01-15T08:00:00.000Z");
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: {
        closeArchivedRoom: vi.fn(async () => {
          throw new Error("gateway secret token=do-not-store");
        }),
      },
      now: () => now,
    });

    await expect(service.archive(scopeA, "document-a")).resolves.toEqual({
      roomClosure: "pending",
      status: "archived",
    });
    const [document] = await harness.database.select().from(documents)
      .where(eq(documents.id, "document-a"));
    const [job] = await harness.database.select().from(collaborationRoomClosureJobs);
    expect(document?.status).toBe("archived");
    expect(job).toMatchObject({
      attempts: 1,
      failureCategory: "delivery_failed",
      nextAttemptAt: new Date(now.valueOf() + 1_000),
      status: "pending",
    });
    expect(JSON.stringify(job)).not.toContain("do-not-store");
  });

  it("is Workspace-scoped and makes duplicate archives side-effect free", async () => {
    const harness = await createHarness("scope-and-duplicate");
    await seedDocument(harness.database, "shared-id", scopeA.workspaceId, true);
    const closeRoom = vi.fn().mockRejectedValue(new Error("offline"));
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: closeRoom },
      now: () => new Date("2027-01-15T08:00:00.000Z"),
    });

    await expect(service.archive(scopeB, "shared-id")).resolves.toEqual({ status: "not_found" });
    await expect(service.archive(scopeA, "shared-id")).resolves.toMatchObject({ status: "archived" });
    await expect(service.archive(scopeA, "shared-id")).resolves.toEqual({
      roomClosure: "pending",
      status: "already_archived",
    });

    expect(closeRoom).toHaveBeenCalledTimes(1);
    await expect(harness.database.select().from(collaborationRoomClosureJobs)).resolves.toHaveLength(1);
  });

  it("reconciles only due jobs in a bounded batch and deletes successful deliveries", async () => {
    const harness = await createHarness("reconcile-success");
    let now = new Date("2027-01-15T08:00:00.000Z");
    for (const documentId of ["document-a", "document-b"]) {
      await seedDocument(harness.database, documentId, scopeA.workspaceId, true);
    }
    const closeRoom = vi.fn().mockRejectedValueOnce(new Error("offline-a"))
      .mockRejectedValueOnce(new Error("offline-b"));
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: closeRoom },
      now: () => now,
    });
    await service.archive(scopeA, "document-a");
    await service.archive(scopeA, "document-b");
    closeRoom.mockResolvedValue(undefined);

    await expect(service.reconcileDueRoomClosures({ limit: 1 })).resolves.toEqual({
      attempted: 0,
      closed: 0,
      exhausted: 0,
      pending: 2,
    });
    now = new Date(now.valueOf() + 1_000);
    await expect(service.reconcileDueRoomClosures({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      closed: 1,
      exhausted: 0,
      pending: 1,
    });
    expect(closeRoom).toHaveBeenCalledTimes(3);
    await expect(harness.database.select().from(collaborationRoomClosureJobs)).resolves.toHaveLength(1);
  });

  it("exhausts retries at the fixed storage bound and never schedules another attempt", async () => {
    const harness = await createHarness("reconcile-exhausted");
    await seedDocument(harness.database, "document-a", scopeA.workspaceId, true);
    let now = new Date("2027-01-15T08:00:00.000Z");
    const closeRoom = vi.fn().mockRejectedValue(new Error("offline"));
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: closeRoom },
      now: () => now,
    });
    await service.archive(scopeA, "document-a");
    for (const delay of [1_000, 2_000, 4_000]) {
      now = new Date(now.valueOf() + delay);
      await expect(service.reconcileDueRoomClosures()).resolves.toMatchObject({
        attempted: 1,
        closed: 0,
        exhausted: 0,
        pending: 1,
      });
    }
    now = new Date(now.valueOf() + 8_000);
    await expect(service.reconcileDueRoomClosures()).resolves.toEqual({
      attempted: 1,
      closed: 0,
      exhausted: 1,
      pending: 0,
    });
    const [job] = await harness.database.select().from(collaborationRoomClosureJobs);
    expect(job).toMatchObject({ attempts: 5, nextAttemptAt: null, status: "exhausted" });

    now = new Date(now.valueOf() + 86_400_000);
    await expect(service.reconcileDueRoomClosures()).resolves.toEqual({
      attempted: 0,
      closed: 0,
      exhausted: 1,
      pending: 0,
    });
    expect(closeRoom).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid identifiers and batch limits without reflecting their values", async () => {
    const harness = await createHarness("invalid-input");
    const secretIdentifier = " secret-document-token ";
    const service = createDocumentArchiveService({
      database: harness.database,
      gateway: { closeArchivedRoom: vi.fn() },
    });

    await expect(service.archive(scopeA, secretIdentifier)).rejects.toBeInstanceOf(DocumentArchiveServiceError);
    await expect(service.archive(scopeA, secretIdentifier)).rejects.not.toThrow(secretIdentifier);
    await expect(service.reconcileDueRoomClosures({ limit: 0 })).rejects.toMatchObject({
      category: "invalid_input",
      message: "Document archive command is invalid",
    });
  });
});

async function createHarness(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-archive-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "archive.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  return { database };
}

async function seedDocument(
  database: Awaited<ReturnType<typeof createHarness>>["database"],
  documentId: string,
  workspaceId: string,
  collaborative: boolean,
) {
  const timestamp = new Date("2027-01-15T07:00:00.000Z");
  await database.insert(documents).values({
    contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    createdAt: timestamp,
    id: documentId,
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    status: "draft",
    title: "Archive fixture",
    updatedAt: timestamp,
    workspaceId,
  });
  if (!collaborative) return;
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
    workspaceId,
  });
}
