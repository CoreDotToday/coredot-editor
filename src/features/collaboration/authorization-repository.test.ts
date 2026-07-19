import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { collaborationAuthorizationEpochs, collaborationDocuments, documents } from "@/db/schema";
import { createCollaborationAuthorizationRepository } from "./authorization-repository";

const tempDirs: string[] = [];
const clients: Client[] = [];
const migrationsFolder = resolve(process.cwd(), "drizzle");
const scope = { workspaceId: "workspace-a" };

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration authorization repository", () => {
  it("reads a draft document's current generation and defaults a missing principal epoch to zero", async () => {
    const harness = await createHarness("read-authority");

    await expect(harness.repository.readCapabilityAuthority(scope, {
      documentId: "document-a",
      principalId: "principal-a",
    })).resolves.toEqual({ authorizationEpoch: 0, generation: 1 });

    await harness.database.update(documents).set({ status: "archived" }).where(eq(documents.id, "document-a"));
    await expect(harness.repository.readCapabilityAuthority(scope, {
      documentId: "document-a",
      principalId: "principal-a",
    })).resolves.toBeNull();
  });

  it("bumps a principal epoch atomically and monotonically across independent clients", async () => {
    const harness = await createHarness("epoch-concurrency");
    const secondClient = createClient({ url: `file:${harness.path}` });
    clients.push(secondClient);
    const second = createCollaborationAuthorizationRepository(drizzle(secondClient, { schema }));
    const repositories = [harness.repository, second];

    const values: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      values.push(...await Promise.all(
        repositories.map((repository) => repository.bumpEpoch(scope, "principal-a")),
      ));
    }

    expect(values.toSorted((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(harness.repository.readEpoch(scope, "principal-a")).resolves.toBe(8);
    const rows = await harness.database.select().from(collaborationAuthorizationEpochs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.epoch).toBe(8);
  });

  it.each([
    [{ workspaceId: "" }, "principal-a"],
    [{ workspaceId: " workspace-a" }, "principal-a"],
    [scope, ""],
    [scope, `principal-${"x".repeat(300)}`],
  ])("rejects unbounded or noncanonical Workspace/principal keys", async (invalidScope, principalId) => {
    const harness = await createHarness("invalid-key");

    await expect(harness.repository.bumpEpoch(invalidScope, principalId))
      .rejects.toThrow("Collaboration authorization input is invalid");
  });
});

async function createHarness(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-capability-${name}-`));
  tempDirs.push(dir);
  const path = join(dir, "test.db");
  const client = createClient({ url: `file:${path}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const timestamp = new Date("2026-07-19T09:00:00.000Z");
  await database.insert(documents).values({
    contentJson: { type: "doc" },
    createdAt: timestamp,
    id: "document-a",
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Document A",
    updatedAt: timestamp,
    workspaceId: scope.workspaceId,
  });
  await database.insert(collaborationDocuments).values({
    checkpointBlob: Buffer.from([1]),
    checkpointChecksum: "a".repeat(64),
    checkpointSeq: 0,
    createdAt: timestamp,
    documentId: "document-a",
    generation: 1,
    headSeq: 0,
    isCurrent: true,
    lastCheckpointAt: timestamp,
    projectedSeq: 0,
    schemaFingerprint: "b".repeat(64),
    schemaVersion: 1,
    updatedAt: timestamp,
    workspaceId: scope.workspaceId,
  });
  return {
    database,
    path,
    repository: createCollaborationAuthorizationRepository(database),
  };
}
