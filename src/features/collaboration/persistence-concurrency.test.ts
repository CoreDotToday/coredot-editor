import { createClient, type Client } from "@libsql/client";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import * as schema from "@/db/schema";
import { collaborationUpdates, documents } from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";

import { COLLABORATION_METADATA_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  createCollaborationPersistence,
  type AppendCollaborationUpdate,
  type CollaborationSnapshot,
} from "./persistence";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const tempDirs: string[] = [];
const clients: Client[] = [];
const scope = { workspaceId: "workspace-race" };
const projectProfile = getProjectProfile("default");

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("CollaborationPersistence cross-client contention", () => {
  it("allocates one monotonic sequence per update across independent libSQL clients", async () => {
    const harness = await createTwoClientHarness("sequence-race");
    await harness.persistenceA.initialize(scope, harness.documentId);
    const snapshotA = await requiredSnapshot(harness.persistenceA.load(scope, harness.documentId));
    const snapshotB = await requiredSnapshot(harness.persistenceB.load(scope, harness.documentId));
    const updateA = metadataUpdate(snapshotA, "owner", "Ada");
    const updateB = metadataUpdate(snapshotB, "category", "research");

    const receipts = await Promise.all([
      harness.persistenceA.appendValidatedUpdate(
        scope,
        command(harness.documentId, updateA, "client-a", "principal-a"),
      ),
      harness.persistenceB.appendValidatedUpdate(
        scope,
        command(harness.documentId, updateB, "client-b", "principal-b"),
      ),
    ]);

    expect(receipts.map(({ seq }) => seq).sort((left, right) => left - right)).toEqual([1, 2]);
    const loadedA = await requiredSnapshot(harness.persistenceA.load(scope, harness.documentId));
    const loadedB = await requiredSnapshot(harness.persistenceB.load(scope, harness.documentId));
    expect(loadedA.headSeq).toBe(2);
    expect(loadedB.headSeq).toBe(2);
    expect(harness.codecA.materialize(loadedA.document).metadataJson).toEqual({
      category: "research",
      owner: "Ada",
    });
    expect(Y.encodeStateAsUpdate(loadedA.document)).toEqual(Y.encodeStateAsUpdate(loadedB.document));
    const updates = await harness.databaseA.select({ seq: collaborationUpdates.seq })
      .from(collaborationUpdates)
      .orderBy(asc(collaborationUpdates.seq));
    expect(updates).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it("converges an identical idempotency race on one durable row and receipt", async () => {
    const harness = await createTwoClientHarness("idempotency-race");
    const snapshot = await harness.persistenceA.initialize(scope, harness.documentId);
    const update = metadataUpdate(snapshot, "owner", "Grace");
    const input = command(harness.documentId, update, "shared-key", "principal-a");

    const [first, second] = await Promise.all([
      harness.persistenceA.appendValidatedUpdate(scope, input),
      harness.persistenceB.appendValidatedUpdate(scope, input),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ headSeq: 1, seq: 1 });
    await expect(harness.databaseA.select().from(collaborationUpdates)).resolves.toHaveLength(1);
  });
});

async function createTwoClientHarness(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-collaboration-${label}-`));
  tempDirs.push(dir);
  const databasePath = join(dir, "collaboration.db");
  const clientA = createClient({ url: `file:${databasePath}` });
  clients.push(clientA);
  const databaseA = drizzle(clientA, { schema });
  await migrate(databaseA, { migrationsFolder });
  await clientA.execute("PRAGMA journal_mode=WAL");
  await clientA.execute("PRAGMA busy_timeout=250");
  const clientB = createClient({ url: `file:${databasePath}` });
  clients.push(clientB);
  await clientB.execute("PRAGMA foreign_keys=ON");
  await clientB.execute("PRAGMA busy_timeout=250");
  const databaseB = drizzle(clientB, { schema });
  const documentId = `document-${label}`;
  await databaseA.insert(documents).values({
    contentJson: { content: [{ type: "paragraph" }], type: "doc" },
    createdAt: new Date(1_000),
    id: documentId,
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Concurrent document",
    updatedAt: new Date(1_000),
    workspaceId: scope.workspaceId,
  });
  const codecA = createCollaborationDocumentCodec(projectProfile);
  const codecB = createCollaborationDocumentCodec(projectProfile);
  return {
    codecA,
    databaseA,
    documentId,
    persistenceA: createCollaborationPersistence(databaseA, { codec: codecA, projectProfile }),
    persistenceB: createCollaborationPersistence(databaseB, { codec: codecB, projectProfile }),
  };
}

function metadataUpdate(snapshot: CollaborationSnapshot, key: string, value: string) {
  const stateVector = Y.encodeStateVector(snapshot.document);
  snapshot.document.getMap(COLLABORATION_METADATA_NAME).set(key, value);
  return Y.encodeStateAsUpdate(snapshot.document, stateVector);
}

function command(
  documentId: string,
  update: Uint8Array,
  idempotencyKey: string,
  principalId: string,
): AppendCollaborationUpdate {
  return {
    documentId,
    generation: 1,
    idempotencyKey,
    originKind: "client",
    principalId,
    requestId: idempotencyKey,
    sessionId: principalId,
    update,
  };
}

async function requiredSnapshot(snapshotPromise: Promise<CollaborationSnapshot | null>) {
  const snapshot = await snapshotPromise;
  if (!snapshot) throw new Error("Expected collaboration snapshot");
  return snapshot;
}
