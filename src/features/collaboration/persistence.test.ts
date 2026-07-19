import { createHash } from "node:crypto";

import { createClient, type Client } from "@libsql/client";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import * as schema from "@/db/schema";
import {
  collaborationDocuments,
  collaborationNoopReceipts,
  collaborationUpdates,
  documentApprovals,
  documents,
} from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";

import { COLLABORATION_METADATA_NAME, COLLABORATION_TITLE_NAME } from "./contracts";
import { CollaborationCodecError, createCollaborationDocumentCodec } from "./document-codec";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type AppendCollaborationUpdate,
  type CollaborationSnapshot,
} from "./persistence";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const tempDirs: string[] = [];
const clients: Client[] = [];
const scope = { workspaceId: "workspace-a" };
const otherScope = { workspaceId: "workspace-b" };
const projectProfile = getProjectProfile("default");

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("CollaborationPersistence", () => {
  it("bootstraps exactly once from the legacy materialization and never falls back to JSON", async () => {
    const harness = await createHarness("bootstrap-once");

    const [first, second] = await Promise.all([
      harness.persistence.initialize(scope, harness.documentId),
      harness.persistence.initialize(scope, harness.documentId),
    ]);

    expect(snapshotIdentity(first)).toEqual(snapshotIdentity(second));
    expect(first.generation).toBe(1);
    expect(first.headSeq).toBe(0);
    expect(harness.codec.materialize(first.document)).toMatchObject({
      metadataJson: { owner: "Legacy" },
      plainText: "Legacy body",
      title: "Legacy title",
    });
    const generations = await harness.database
      .select()
      .from(collaborationDocuments)
      .where(and(
        eq(collaborationDocuments.workspaceId, scope.workspaceId),
        eq(collaborationDocuments.documentId, harness.documentId),
      ));
    expect(generations).toHaveLength(1);
    expect(generations[0]?.isCurrent).toBe(true);

    await harness.database.update(documents).set({
      contentJson: paragraphDocument("Poisoned JSON body"),
      metadataJson: { owner: "Poisoned" },
      plainText: "Poisoned JSON body",
      title: "Poisoned JSON title",
    }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));

    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(loaded).not.toBeNull();
    expect(harness.codec.materialize(loaded!.document)).toMatchObject({
      metadataJson: { owner: "Legacy" },
      plainText: "Legacy body",
      title: "Legacy title",
    });
  });

  it("fails closed without bootstrapping when collaboration history has no current generation", async () => {
    const harness = await createHarness("retired-history");
    await harness.persistence.initialize(scope, harness.documentId);
    await harness.database.update(collaborationDocuments).set({ isCurrent: false }).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
    ));
    const bootstrap = vi.spyOn(harness.codec, "bootstrap");

    await expect(harness.persistence.initialize(scope, harness.documentId)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("initializes and appends a legacy document in one write transaction", async () => {
    const harness = await createHarness("single-append-transaction");
    const seedDocument = harness.codec.bootstrap({
      contentJson: paragraphDocument("Legacy body"),
      metadataJson: { owner: "Legacy" },
      plainText: "Legacy body",
      title: "Legacy title",
    });
    const update = mutateSnapshot({
      checkpointSeq: 0,
      document: seedDocument,
      documentId: harness.documentId,
      generation: 1,
      headSeq: 0,
      projectedSeq: 0,
      schemaFingerprint: harness.codec.fingerprint(),
      schemaVersion: 1,
    }, (document) => replaceTitle(document, "Single transaction"));
    const transaction = vi.spyOn(harness.database.$client, "transaction");

    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update),
    );

    expect(transaction.mock.calls as unknown as Array<[unknown]>).toEqual([["write"]]);
  });

  it("rejects appends to an archived initialized document without durable side effects", async () => {
    const harness = await createHarness("archived-append");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    await harness.database.update(documents).set({
      readiness: "approved",
      status: "archived",
    }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.database.insert(documentApprovals).values({
      approvedAt: new Date(1_000),
      approvedContentHash: "c".repeat(64),
      approvedHeadSeq: 0,
      approvedStateVector: Buffer.from(Y.encodeStateVector(snapshot.document)),
      documentId: harness.documentId,
      generation: 1,
      id: "archived-approval",
      principalId: "approver",
      requestId: "archived-approval-request",
      workspaceId: scope.workspaceId,
    });
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Must not append");
    });

    const failure = await capturePersistenceFailure(() => harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "archived-write" }),
    ));

    expect(failure).toMatchObject({ category: "not_found", retryable: false });
    expect(failure.message.length).toBeLessThanOrEqual(120);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(0);
    await expect(harness.persistence.load(scope, harness.documentId)).resolves.toMatchObject({ headSeq: 0 });
    const [approval] = await harness.database.select().from(documentApprovals);
    expect(approval).toMatchObject({ invalidatedAt: null, invalidatedSeq: null });
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      readiness: "approved",
      revision: 0,
      status: "archived",
    });
  });

  it("keeps the archive fence ahead of durable no-op replay", async () => {
    const harness = await createHarness("archived-noop-replay");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const duplicateState = Y.encodeStateAsUpdate(snapshot.document);
    const command = appendCommand(harness.documentId, 1, duplicateState, {
      idempotencyKey: "archived-noop-key",
    });
    const receipt = await harness.persistence.appendValidatedUpdate(scope, command);
    await harness.database.update(documents).set({ status: "archived" }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));

    await expect(harness.persistence.appendValidatedUpdate(scope, command)).rejects.toMatchObject({
      category: "not_found",
      retryable: false,
    });
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toEqual([
      expect.objectContaining({
        generation: receipt.generation,
        headSeq: receipt.headSeq,
        idempotencyKey: "archived-noop-key",
      }),
    ]);
  });

  it("allocates monotonic sequences and returns the current head for a duplicate Yjs no-op", async () => {
    const harness = await createHarness("append-idempotency");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Durable title");
    });
    const command = appendCommand(harness.documentId, snapshot.generation, update, {
      idempotencyKey: "append-title-1",
    });

    const first = await harness.persistence.appendValidatedUpdate(scope, command);
    const replay = await harness.persistence.appendValidatedUpdate(scope, command);
    const duplicate = await harness.persistence.appendValidatedUpdate(scope, {
      ...command,
      idempotencyKey: "append-title-duplicate",
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ generation: 1, headSeq: 1, seq: 1 });
    expect(duplicate).toMatchObject({
      checksum: sha256(update),
      generation: 1,
      headSeq: 1,
      seq: 1,
    });
    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(loaded?.headSeq).toBe(1);
    expect(harness.codec.materialize(loaded!.document).title).toBe("Durable title");
    const updates = await harness.database
      .select({ idempotencyKey: collaborationUpdates.idempotencyKey, seq: collaborationUpdates.seq })
      .from(collaborationUpdates)
      .orderBy(asc(collaborationUpdates.seq));
    expect(updates).toEqual([{ idempotencyKey: "append-title-1", seq: 1 }]);
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toEqual([
      expect.objectContaining({
        generation: 1,
        headSeq: 1,
        idempotencyKey: "append-title-duplicate",
      }),
    ]);
  });

  it("does not persist a duplicate delete-only Yjs update", async () => {
    const harness = await createHarness("noop-delete-only");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const stateVector = Y.encodeStateVector(snapshot.document);
    snapshot.document.getText(COLLABORATION_TITLE_NAME).delete(0, 1);
    const deleteUpdate = Y.encodeStateAsUpdate(snapshot.document, stateVector);
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, deleteUpdate, { idempotencyKey: "delete-once" }),
    );

    const duplicate = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, deleteUpdate, { idempotencyKey: "delete-duplicate" }),
    );

    expect(duplicate).toMatchObject({
      checksum: sha256(deleteUpdate),
      generation: 1,
      headSeq: 1,
      seq: 1,
    });
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "delete-once", seq: 1 }),
    ]);
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "delete-duplicate", headSeq: 1 }),
    ]);
  });

  it("preserves approval and readiness for a no-op update", async () => {
    const harness = await createHarness("noop-approval");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    await harness.database.update(documents).set({ readiness: "approved" }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.database.insert(documentApprovals).values({
      approvedAt: new Date(1_000),
      approvedContentHash: "d".repeat(64),
      approvedHeadSeq: 0,
      approvedStateVector: Buffer.from(Y.encodeStateVector(snapshot.document)),
      documentId: harness.documentId,
      generation: 1,
      id: "noop-approval",
      principalId: "approver",
      requestId: "noop-approval-request",
      workspaceId: scope.workspaceId,
    });
    const duplicateState = Y.encodeStateAsUpdate(snapshot.document);

    const receipt = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, duplicateState, {
        idempotencyKey: "noop-approved-update",
      }),
    );

    expect(receipt).toMatchObject({
      checksum: sha256(duplicateState),
      generation: 1,
      headSeq: 0,
      seq: 0,
    });
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(0);
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "noop-approved-update", headSeq: 0 }),
    ]);
    const [approval] = await harness.database.select().from(documentApprovals);
    expect(approval).toMatchObject({ invalidatedAt: null, invalidatedSeq: null });
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      readiness: "approved",
      revision: 0,
    });
  });

  it("gives a no-op idempotency key a durable receipt across later heads", async () => {
    const harness = await createHarness("noop-idempotency-limit");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const titleUpdate = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "First durable head");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, titleUpdate, { idempotencyKey: "first-head" }),
    );
    const noOpCommand = appendCommand(harness.documentId, 1, titleUpdate, {
        idempotencyKey: "durable-noop-key",
    });
    const firstNoOp = await harness.persistence.appendValidatedUpdate(scope, noOpCommand);
    const metadataUpdate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "later-head");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, metadataUpdate, { idempotencyKey: "second-head" }),
    );

    const laterNoOp = await harness.persistence.appendValidatedUpdate(scope, noOpCommand);

    expect(firstNoOp).toMatchObject({ headSeq: 1, seq: 1 });
    expect(laterNoOp).toEqual(firstNoOp);
    const updates = await harness.database.select({ idempotencyKey: collaborationUpdates.idempotencyKey })
      .from(collaborationUpdates);
    expect(updates).toEqual(expect.arrayContaining([
      { idempotencyKey: "first-head" },
      { idempotencyKey: "second-head" },
    ]));
    expect(updates).not.toContainEqual({ idempotencyKey: "durable-noop-key" });
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toEqual([
      expect.objectContaining({
        checksum: sha256(titleUpdate),
        generation: 1,
        headSeq: 1,
        idempotencyKey: "durable-noop-key",
      }),
    ]);
  });

  it("rejects a no-op receipt replay with a different payload or audit identity", async () => {
    const harness = await createHarness("noop-idempotency-conflict");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const duplicateState = Y.encodeStateAsUpdate(snapshot.document);
    const command = appendCommand(harness.documentId, 1, duplicateState, {
      idempotencyKey: "stable-noop-key",
      requestId: "request-original",
    });
    await harness.persistence.appendValidatedUpdate(scope, command);

    await expect(harness.persistence.appendValidatedUpdate(scope, {
      ...command,
      update: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
    await expect(harness.persistence.appendValidatedUpdate(scope, {
      ...command,
      requestId: "request-other",
    })).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(0);
  });

  it("persists a dependent update received before its prerequisite and converges after recovery", async () => {
    const harness = await createHarness("pending-struct-recovery");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const { first, second } = dependentTitleUpdates(snapshot, "A", "B");

    const secondReceipt = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, second, { idempotencyKey: "dependent-b" }),
    );
    const firstReceipt = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, first, { idempotencyKey: "prerequisite-a" }),
    );

    expect(secondReceipt).toMatchObject({ headSeq: 1, seq: 1 });
    expect(firstReceipt).toMatchObject({ headSeq: 2, seq: 2 });
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toHaveLength(0);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(2);
    const recovered = await harness.persistence.load(scope, harness.documentId);
    expect(harness.codec.materialize(recovered!.document).title).toBe("Legacy titleAB");
  });

  it("preserves dependent updates across a new persistence instance", async () => {
    const harness = await createHarness("pending-struct-restart");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const { first, second } = dependentTitleUpdates(snapshot, "A", "B");
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, second, { idempotencyKey: "restart-dependent-b" }),
    );
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, first, { idempotencyKey: "restart-prerequisite-a" }),
    );
    const restartCodec = createCollaborationDocumentCodec(projectProfile);
    const restarted = createCollaborationPersistence(harness.database, {
      codec: restartCodec,
      projectProfile,
    });

    const recovered = await restarted.load(scope, harness.documentId);

    expect(restartCodec.materialize(recovered!.document).title).toBe("Legacy titleAB");
  });

  it("persists an out-of-order delete set until its insertion dependency arrives", async () => {
    const harness = await createHarness("pending-delete-set");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const { deletion, insertion } = dependentInsertDeleteUpdates(snapshot, "X");

    const deletionReceipt = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, deletion, { idempotencyKey: "dependent-delete" }),
    );
    const insertionReceipt = await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, insertion, { idempotencyKey: "prerequisite-insert" }),
    );

    expect(deletionReceipt).toMatchObject({ headSeq: 1, seq: 1 });
    expect(insertionReceipt).toMatchObject({ headSeq: 2, seq: 2 });
    const recovered = await harness.persistence.load(scope, harness.documentId);
    expect(harness.codec.materialize(recovered!.document).title).toBe("Legacy title");
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(2);
    await expect(harness.database.select().from(collaborationNoopReceipts)).resolves.toHaveLength(0);
  });

  it("checkpoints unresolved dependencies so later arrivals still converge after restart", async () => {
    const harness = await createHarness("pending-checkpoint");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const { first, second } = dependentTitleUpdates(snapshot, "A", "B");
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, second, { idempotencyKey: "checkpoint-dependent-b" }),
    );

    const checkpoint = await harness.persistence.checkpoint(scope, harness.documentId, 1);
    expect(checkpoint).toMatchObject({ checkpointSeq: 1, projectedSeq: 1 });
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      title: "Legacy title",
    });
    const restartCodec = createCollaborationDocumentCodec(projectProfile);
    const restarted = createCollaborationPersistence(harness.database, {
      codec: restartCodec,
      projectProfile,
    });
    await restarted.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, first, { idempotencyKey: "checkpoint-prerequisite-a" }),
    );

    const recovered = await restarted.load(scope, harness.documentId);
    expect(restartCodec.materialize(recovered!.document).title).toBe("Legacy titleAB");
  });

  it("reprojects an unresolved dependency after its prerequisite arrives across restart", async () => {
    const harness = await createHarness("pending-projection");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const { first, second } = dependentTitleUpdates(snapshot, "A", "B");
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, second, { idempotencyKey: "project-dependent-b" }),
    );

    await expect(harness.persistence.project(scope, harness.documentId, 1)).resolves.toMatchObject({
      projectedSeq: 1,
    });
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      title: "Legacy title",
    });
    const restartCodec = createCollaborationDocumentCodec(projectProfile);
    const restarted = createCollaborationPersistence(harness.database, {
      codec: restartCodec,
      projectProfile,
    });
    await restarted.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, first, { idempotencyKey: "project-prerequisite-a" }),
    );
    await expect(restarted.project(scope, harness.documentId, 2)).resolves.toMatchObject({
      projectedSeq: 2,
    });

    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      title: "Legacy titleAB",
    });
    const secondRestartCodec = createCollaborationDocumentCodec(projectProfile);
    const secondRestart = createCollaborationPersistence(harness.database, {
      codec: secondRestartCodec,
      projectProfile,
    });
    const recovered = await secondRestart.load(scope, harness.documentId);
    expect(secondRestartCodec.materialize(recovered!.document).title).toBe("Legacy titleAB");
  });

  it("rejects changed and no-op updates that collide across receipt tables in either direction", async () => {
    const harness = await createHarness("cross-table-idempotency");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const duplicateState = Y.encodeStateAsUpdate(snapshot.document);
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, duplicateState, { idempotencyKey: "noop-first" }),
    );
    const changed = mutateSnapshot(snapshot, (document) => replaceTitle(document, "Changed once"));

    await expect(harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, changed, { idempotencyKey: "noop-first" }),
    )).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });

    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, changed, { idempotencyKey: "changed-first" }),
    );
    await expect(harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, duplicateState, { idempotencyKey: "changed-first" }),
    )).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
  });

  it("fails closed when the same document key exists in both receipt sources", async () => {
    const harness = await createHarness("dual-receipt-corruption");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => replaceTitle(document, "Durable change"));
    const command = appendCommand(harness.documentId, 1, update, { idempotencyKey: "dual-key" });
    await harness.persistence.appendValidatedUpdate(scope, command);
    await harness.database.insert(collaborationNoopReceipts).values({
      checksum: sha256(update),
      createdAt: new Date(2_000),
      documentId: harness.documentId,
      generation: 1,
      headSeq: 1,
      idempotencyKey: "dual-key",
      originKind: command.originKind,
      principalId: command.principalId,
      requestId: command.requestId,
      semanticActionId: command.semanticActionId,
      sessionId: command.sessionId,
      workspaceId: scope.workspaceId,
    });

    await expect(harness.persistence.appendValidatedUpdate(scope, command)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
  });

  it("fails closed when an update idempotency key appears in multiple generations", async () => {
    const harness = await createHarness("multiple-update-receipts");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => replaceTitle(document, "Repeated key"));
    const command = appendCommand(harness.documentId, 1, update, {
      idempotencyKey: "multi-generation-key",
    });
    await harness.persistence.appendValidatedUpdate(scope, command);
    const loaded = await harness.persistence.load(scope, harness.documentId);
    const checkpoint = harness.codec.encodeCheckpoint(loaded!.document);
    await harness.database.update(collaborationDocuments).set({ isCurrent: false }).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.generation, 1),
    ));
    await harness.database.insert(collaborationDocuments).values({
      checkpointBlob: Buffer.from(checkpoint),
      checkpointChecksum: sha256(checkpoint),
      checkpointSeq: 1,
      createdAt: new Date(2_000),
      documentId: harness.documentId,
      generation: 2,
      headSeq: 2,
      isCurrent: true,
      lastCheckpointAt: new Date(2_000),
      projectedSeq: 1,
      schemaFingerprint: harness.codec.fingerprint(),
      schemaVersion: 1,
      updatedAt: new Date(2_000),
      workspaceId: scope.workspaceId,
    });
    await harness.database.insert(collaborationUpdates).values({
      checksum: sha256(update),
      createdAt: new Date(2_000),
      documentId: harness.documentId,
      generation: 2,
      idempotencyKey: "multi-generation-key",
      originKind: command.originKind,
      principalId: command.principalId,
      requestId: command.requestId,
      semanticActionId: command.semanticActionId,
      seq: 2,
      sessionId: command.sessionId,
      updateBlob: Buffer.from(update),
      workspaceId: scope.workspaceId,
    });

    await expect(harness.persistence.appendValidatedUpdate(scope, command)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
  });

  it("fails closed when a no-op receipt points beyond its generation head", async () => {
    const harness = await createHarness("noop-receipt-future-head");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const duplicateState = Y.encodeStateAsUpdate(snapshot.document);
    const command = appendCommand(harness.documentId, 1, duplicateState, {
      idempotencyKey: "future-head-noop",
    });
    await harness.persistence.appendValidatedUpdate(scope, command);
    await harness.database.update(collaborationNoopReceipts).set({ headSeq: 1 }).where(and(
      eq(collaborationNoopReceipts.workspaceId, scope.workspaceId),
      eq(collaborationNoopReceipts.documentId, harness.documentId),
      eq(collaborationNoopReceipts.idempotencyKey, "future-head-noop"),
    ));

    await expect(harness.persistence.appendValidatedUpdate(scope, command)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
  });

  it("fails closed when a retained update receipt points beyond its retired generation head", async () => {
    const harness = await createHarness("update-receipt-future-head");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => replaceTitle(document, "Retained update"));
    const command = appendCommand(harness.documentId, 1, update, {
      idempotencyKey: "retained-update-key",
    });
    await harness.persistence.appendValidatedUpdate(scope, command);
    const loaded = await harness.persistence.load(scope, harness.documentId);
    const checkpoint = harness.codec.encodeCheckpoint(loaded!.document);
    await harness.database.update(collaborationDocuments).set({ isCurrent: false }).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.generation, 1),
    ));
    await harness.database.insert(collaborationDocuments).values({
      checkpointBlob: Buffer.from(checkpoint),
      checkpointChecksum: sha256(checkpoint),
      checkpointSeq: 1,
      createdAt: new Date(2_000),
      documentId: harness.documentId,
      generation: 2,
      headSeq: 1,
      isCurrent: true,
      lastCheckpointAt: new Date(2_000),
      projectedSeq: 1,
      schemaFingerprint: harness.codec.fingerprint(),
      schemaVersion: 1,
      updatedAt: new Date(2_000),
      workspaceId: scope.workspaceId,
    });
    await harness.database.update(collaborationDocuments).set({
      headSeq: 0,
      projectedSeq: 0,
    }).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.generation, 1),
    ));

    await expect(harness.persistence.appendValidatedUpdate(scope, command)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
  });

  it("fails closed when an idempotency key is replayed with a different checksum or audit identity", async () => {
    const harness = await createHarness("idempotency-conflict");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("owner", "Ada");
    });
    const command = appendCommand(harness.documentId, snapshot.generation, update, {
      idempotencyKey: "stable-key",
      requestId: "request-original",
    });
    await harness.persistence.appendValidatedUpdate(scope, command);

    await expect(harness.persistence.appendValidatedUpdate(scope, {
      ...command,
      update: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
    await expect(harness.persistence.appendValidatedUpdate(scope, {
      ...command,
      principalId: "principal-other",
    })).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
    await expect(harness.persistence.load(scope, harness.documentId)).resolves.toMatchObject({ headSeq: 1 });
  });

  it("recovers from a checkpoint plus ordered tail and rejects checksum or schema corruption", async () => {
    const harness = await createHarness("checkpoint-tail");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const titleUpdate = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Checkpoint title");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, snapshot.generation, titleUpdate, { idempotencyKey: "title" }),
    );
    const checkpoint = await harness.persistence.checkpoint(scope, harness.documentId, 1);
    expect(checkpoint).toMatchObject({ checkpointSeq: 1, generation: 1, projectedSeq: 1 });

    const metadataUpdate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "research");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, metadataUpdate, { idempotencyKey: "metadata" }),
    );
    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(loaded).toMatchObject({ checkpointSeq: 1, headSeq: 2 });
    expect(harness.codec.materialize(loaded!.document)).toMatchObject({
      metadataJson: { category: "research", owner: "Legacy" },
      title: "Checkpoint title",
    });

    await harness.database.update(collaborationUpdates).set({ checksum: "f".repeat(64) }).where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, harness.documentId),
      eq(collaborationUpdates.generation, 1),
      eq(collaborationUpdates.seq, 2),
    ));
    await expect(harness.persistence.load(scope, harness.documentId)).rejects.toMatchObject({
      category: "checksum_mismatch",
      retryable: false,
    });

    await harness.database.update(collaborationUpdates).set({ checksum: sha256(metadataUpdate) }).where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, harness.documentId),
      eq(collaborationUpdates.generation, 1),
      eq(collaborationUpdates.seq, 2),
    ));
    await harness.database.update(collaborationDocuments).set({ schemaFingerprint: "e".repeat(64) }).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.generation, 1),
    ));
    await expect(harness.persistence.load(scope, harness.documentId)).rejects.toMatchObject({
      category: "schema_mismatch",
      retryable: false,
    });
  });

  it("does not advance the materialized revision for a repeated checkpoint at the same head", async () => {
    const harness = await createHarness("checkpoint-same-head");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Checkpoint once");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update),
    );

    await harness.persistence.checkpoint(scope, harness.documentId, 1);
    const first = await readLegacyDocument(harness.database, harness.documentId);
    await harness.persistence.checkpoint(scope, harness.documentId, 1);
    const repeated = await readLegacyDocument(harness.database, harness.documentId);

    expect(first).toMatchObject({ revision: 1, title: "Checkpoint once" });
    expect(repeated).toMatchObject({ revision: 1, title: "Checkpoint once" });
  });

  it("fails closed when a current generation has an update beyond its durable head", async () => {
    const harness = await createHarness("orphan-future-tail");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const orphan = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Orphan future update");
    });
    await harness.database.insert(collaborationUpdates).values({
      checksum: sha256(orphan),
      createdAt: new Date(2_000),
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "orphan-future-tail",
      originKind: "client",
      principalId: "orphan-principal",
      seq: 2,
      updateBlob: Buffer.from(orphan),
      workspaceId: scope.workspaceId,
    });

    await expect(harness.persistence.load(scope, harness.documentId)).rejects.toMatchObject({
      category: "corrupt_state",
      retryable: false,
    });
  });

  it("loads normally when retained updates are at or below the checkpoint", async () => {
    const harness = await createHarness("retained-checkpoint-tail");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Retained checkpoint title");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "retained-update" }),
    );
    await harness.persistence.checkpoint(scope, harness.documentId, 1);

    await expect(harness.database.select().from(collaborationUpdates)).resolves.toEqual([
      expect.objectContaining({ generation: 1, seq: 1 }),
    ]);
    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(loaded).toMatchObject({ checkpointSeq: 1, headSeq: 1 });
    expect(harness.codec.materialize(loaded!.document).title).toBe("Retained checkpoint title");
  });

  it("projects only through the requested sequence and preserves sequence fencing", async () => {
    const harness = await createHarness("projection");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const titleUpdate = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Projected title");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, titleUpdate, { idempotencyKey: "project-title" }),
    );
    const metadataUpdate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "plan");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, metadataUpdate, { idempotencyKey: "project-metadata" }),
    );

    const firstProjection = await harness.persistence.project(scope, harness.documentId, 1);
    const firstDocument = await readLegacyDocument(harness.database, harness.documentId);
    expect(firstProjection).toMatchObject({ generation: 1, projectedSeq: 1 });
    expect(firstDocument).toMatchObject({
      metadataJson: { owner: "Legacy" },
      title: "Projected title",
    });

    await expect(harness.persistence.project(scope, harness.documentId, 3)).rejects.toMatchObject({
      category: "projection_fence",
      retryable: false,
    });
    const secondProjection = await harness.persistence.project(scope, harness.documentId, 2);
    const secondDocument = await readLegacyDocument(harness.database, harness.documentId);
    expect(secondProjection.projectedSeq).toBe(2);
    expect(secondDocument.metadataJson).toEqual({ category: "plan", owner: "Legacy" });
    const [state] = await harness.database
      .select()
      .from(collaborationDocuments)
      .where(eq(collaborationDocuments.documentId, harness.documentId));
    expect(state).toMatchObject({ checkpointSeq: 0, headSeq: 2, projectedSeq: 2 });
  });

  it("invalidates the active approval and sets server-owned readiness in the append transaction", async () => {
    const harness = await createHarness("approval");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    await harness.database.update(documents).set({ readiness: "approved" }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.database.insert(documentApprovals).values({
      approvedAt: new Date(1_000),
      approvedContentHash: "a".repeat(64),
      approvedHeadSeq: 0,
      approvedStateVector: Buffer.from(Y.encodeStateVector(snapshot.document)),
      documentId: harness.documentId,
      generation: 1,
      id: "approval-active",
      principalId: "approver",
      requestId: "approval-request",
      workspaceId: scope.workspaceId,
    });
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Needs another review");
    });

    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, {
        idempotencyKey: "approval-invalidating-update",
        principalId: "editor-principal",
      }),
    );

    const [approval] = await harness.database.select().from(documentApprovals);
    const currentDocument = await readLegacyDocument(harness.database, harness.documentId);
    expect(approval).toMatchObject({
      invalidatedPrincipalId: "editor-principal",
      invalidatedSeq: 1,
    });
    expect(approval?.invalidatedAt).toBeInstanceOf(Date);
    expect(currentDocument.readiness).toBe("needs_review");
  });

  it("downgrades legacy approved readiness without inventing an approval record", async () => {
    const harness = await createHarness("legacy-approved-without-approval");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    await harness.database.update(documents).set({ readiness: "approved" }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Migration mutation");
    });

    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, {
        idempotencyKey: "legacy-approved-mutation",
      }),
    );

    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(0);
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      readiness: "needs_review",
      revision: 1,
    });
  });

  it("rotates before applying the candidate update, preserves Yjs clocks, and fences the retired generation", async () => {
    const harness = await createHarness("rotation");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const persistedTail = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("owner", "Ada");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, persistedTail, { idempotencyKey: "pre-rotation-tail" }),
    );
    const preRotationNoop = appendCommand(harness.documentId, 1, persistedTail, {
      idempotencyKey: "pre-rotation-noop",
    });
    const preRotationReceipt = await harness.persistence.appendValidatedUpdate(scope, preRotationNoop);
    await harness.database.update(documents).set({
      contentJson: paragraphDocument("Must not become canonical"),
      metadataJson: { owner: "Poisoned" },
      plainText: "Must not become canonical",
      title: "Poisoned projection",
    }).where(eq(documents.id, harness.documentId));
    const update = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "rotated");
    });
    const [current] = await harness.database.select().from(collaborationDocuments);
    const [tail] = await harness.database.select().from(collaborationUpdates);
    if (!current || !tail) throw new Error("Expected pre-rotation state");
    const rotating = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: {
        cumulativeUpdateBytes:
          current.checkpointBlob.byteLength + tail.updateBlob.byteLength + update.byteLength - 1,
      },
    });

    const receipt = await rotating.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "rotate-update" }),
    );

    expect(receipt).toMatchObject({ generation: 2, headSeq: 2, seq: 2 });
    const generationRows = await harness.database.select().from(collaborationDocuments)
      .orderBy(asc(collaborationDocuments.generation));
    expect(generationRows.map(({ generation, headSeq, isCurrent }) => ({ generation, headSeq, isCurrent }))).toEqual([
      { generation: 1, headSeq: 1, isCurrent: false },
      { generation: 2, headSeq: 2, isCurrent: true },
    ]);
    const updateRows = await harness.database.select().from(collaborationUpdates);
    expect(updateRows).toHaveLength(2);
    expect(updateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: 1, seq: 1 }),
      expect.objectContaining({ generation: 2, seq: 2 }),
    ]));
    const loaded = await rotating.load(scope, harness.documentId);
    expect(Y.encodeStateVector(loaded!.document)).toEqual(Y.encodeStateVector(snapshot.document));
    expect(harness.codec.materialize(loaded!.document)).toMatchObject({
      metadataJson: { category: "rotated", owner: "Ada" },
      title: "Legacy title",
    });
    await expect(rotating.appendValidatedUpdate(scope, preRotationNoop)).resolves.toEqual(preRotationReceipt);

    await expect(rotating.appendValidatedUpdate(scope, {
      ...appendCommand(harness.documentId, 1, update, { idempotencyKey: "stale-generation" }),
    })).rejects.toMatchObject({ category: "stale_generation", retryable: true });
  });

  it("combines rotation projection and legacy readiness downgrade into one revision", async () => {
    const harness = await createHarness("rotation-legacy-approved");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const tailUpdate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("owner", "Migrated owner");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, tailUpdate, {
        idempotencyKey: "rotation-readiness-tail",
      }),
    );
    await harness.database.update(documents).set({ readiness: "approved" }).where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    const candidate = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Rotated approved migration");
    });
    const [current] = await harness.database.select().from(collaborationDocuments);
    const [tail] = await harness.database.select().from(collaborationUpdates);
    if (!current || !tail) throw new Error("Expected collaboration state");
    const rotating = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: {
        cumulativeUpdateBytes:
          current.checkpointBlob.byteLength + tail.updateBlob.byteLength + candidate.byteLength - 1,
      },
    });

    await rotating.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, candidate, {
        idempotencyKey: "rotation-readiness-migration",
      }),
    );

    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(0);
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      readiness: "needs_review",
      revision: 1,
    });
  });

  it("does not rotate, project, or revise for a no-op at the rotation threshold", async () => {
    const harness = await createHarness("noop-near-rotation");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Canonical but not projected");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "near-rotation-head" }),
    );
    const [current] = await harness.database.select().from(collaborationDocuments);
    const [tail] = await harness.database.select().from(collaborationUpdates);
    if (!current || !tail) throw new Error("Expected persisted collaboration state");
    const rotating = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: {
        cumulativeUpdateBytes:
          current.checkpointBlob.byteLength + tail.updateBlob.byteLength + update.byteLength - 1,
      },
    });

    const receipt = await rotating.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "near-rotation-noop" }),
    );

    expect(receipt).toMatchObject({
      checksum: sha256(update),
      generation: 1,
      headSeq: 1,
      seq: 1,
    });
    await expect(harness.database.select().from(collaborationDocuments)).resolves.toEqual([
      expect.objectContaining({ generation: 1, headSeq: 1, isCurrent: true, projectedSeq: 0 }),
    ]);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toEqual([
      expect.objectContaining({ generation: 1, idempotencyKey: "near-rotation-head", seq: 1 }),
    ]);
    await expect(readLegacyDocument(harness.database, harness.documentId)).resolves.toMatchObject({
      readiness: "draft",
      revision: 0,
      title: "Legacy title",
    });
  });

  it("counts checkpoint bytes, post-checkpoint tail, and the candidate before deciding to rotate", async () => {
    const harness = await createHarness("rotation-tracked-bytes");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const firstUpdate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("owner", "Ada");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, firstUpdate, { idempotencyKey: "tracked-first" }),
    );
    const [current] = await harness.database.select().from(collaborationDocuments);
    const [tail] = await harness.database.select().from(collaborationUpdates);
    if (!current || !tail) throw new Error("Expected persisted collaboration state");
    const candidate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "tracked-rotation");
    });
    const persistence = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: {
        cumulativeUpdateBytes:
          current.checkpointBlob.byteLength + tail.updateBlob.byteLength + candidate.byteLength - 1,
      },
    });

    const receipt = await persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, candidate, { idempotencyKey: "tracked-candidate" }),
    );

    expect(receipt).toMatchObject({ generation: 2, headSeq: 2, seq: 2 });
    const generations = await harness.database.select().from(collaborationDocuments)
      .orderBy(asc(collaborationDocuments.generation));
    expect(generations).toEqual([
      expect.objectContaining({ generation: 1, headSeq: 1, isCurrent: false }),
      expect.objectContaining({
        checkpointSeq: 1,
        generation: 2,
        headSeq: 2,
        isCurrent: true,
        projectedSeq: 1,
      }),
    ]);
  });

  it("carries sequence fences through rotation so an old-head approval keeps its audit identity", async () => {
    const harness = await createHarness("rotation-active-approval");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const approvedUpdate = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Approved canonical title");
    });
    await harness.persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, approvedUpdate, { idempotencyKey: "approved-state" }),
    );
    await harness.database.update(documents).set({
      readiness: "approved",
      title: "Stale materialized title",
    }).where(eq(documents.id, harness.documentId));
    await harness.database.insert(documentApprovals).values({
      approvedAt: new Date(1_000),
      approvedContentHash: "b".repeat(64),
      approvedHeadSeq: 1,
      approvedStateVector: Buffer.from(Y.encodeStateVector(snapshot.document)),
      documentId: harness.documentId,
      generation: 1,
      id: "approval-before-rotation",
      principalId: "approver",
      requestId: "approval-before-rotation-request",
      workspaceId: scope.workspaceId,
    });
    const candidate = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "post-approval");
    });
    const [current] = await harness.database.select().from(collaborationDocuments);
    const [tail] = await harness.database.select().from(collaborationUpdates);
    if (!current || !tail) throw new Error("Expected approved collaboration state");
    const rotating = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: {
        cumulativeUpdateBytes:
          current.checkpointBlob.byteLength + tail.updateBlob.byteLength + candidate.byteLength - 1,
      },
    });

    const receipt = await rotating.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, candidate, {
        idempotencyKey: "approval-rotation-candidate",
        principalId: "editing-principal",
      }),
    );

    expect(receipt).toMatchObject({ generation: 2, headSeq: 2, seq: 2 });
    const [approval] = await harness.database.select().from(documentApprovals);
    expect(approval).toMatchObject({
      approvedHeadSeq: 1,
      generation: 1,
      invalidatedPrincipalId: "editing-principal",
      invalidatedSeq: 2,
    });
    const currentDocument = await readLegacyDocument(harness.database, harness.documentId);
    expect(currentDocument).toMatchObject({
      readiness: "needs_review",
      revision: 1,
      title: "Approved canonical title",
    });
    const loaded = await rotating.load(scope, harness.documentId);
    expect(loaded).toMatchObject({ checkpointSeq: 1, generation: 2, headSeq: 2, projectedSeq: 1 });
    expect(harness.codec.materialize(loaded!.document).metadataJson).toMatchObject({
      category: "post-approval",
    });
  });

  it("returns a bounded retryable failure when safe rotation cannot encode its checkpoint", async () => {
    const harness = await createHarness("rotation-budget-failure");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "blocked");
    });
    const constrained = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile,
      storageLimits: { checkpointBytes: 1, cumulativeUpdateBytes: 1 },
    });

    const failure = await capturePersistenceFailure(() => constrained.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, { idempotencyKey: "cannot-rotate" }),
    ));

    expect(failure).toMatchObject({ category: "storage_budget", retryable: true });
    expect(failure.message.length).toBeLessThanOrEqual(120);
    await expect(harness.persistence.load(scope, harness.documentId)).resolves.toMatchObject({
      generation: 1,
      headSeq: 0,
    });
  });

  it("maps a candidate checkpoint budget failure to retryable storage budget", async () => {
    const harness = await createHarness("candidate-checkpoint-budget");
    const snapshot = await harness.persistence.initialize(scope, harness.documentId);
    const update = mutateSnapshot(snapshot, (document) => {
      replaceTitle(document, "Budget boundary");
    });
    const budgetCodec = {
      ...harness.codec,
      encodeCheckpoint: vi.fn(() => {
        throw new CollaborationCodecError({ ok: false, reason: "checkpoint_budget" });
      }),
    };
    const persistence = createCollaborationPersistence(harness.database, {
      codec: budgetCodec,
      projectProfile,
    });

    const failure = await capturePersistenceFailure(() => persistence.appendValidatedUpdate(
      scope,
      appendCommand(harness.documentId, 1, update, {
        idempotencyKey: "candidate-budget",
      }),
    ));

    expect(failure).toMatchObject({ category: "storage_budget", retryable: true });
  });

  it("rejects invalid append fields before opening a database transaction", async () => {
    const transaction = vi.fn(() => Promise.reject(new Error("database must not be touched")));
    const persistence = createCollaborationPersistence({
      $client: { transaction },
      transaction,
    } as never, { projectProfile });
    const base = appendCommand("document-secret", 1, new Uint8Array([1]), {
      idempotencyKey: "idempotency-secret",
      principalId: "principal-secret",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: Array<[string, AppendCollaborationUpdate]> = [
      ["generation", { ...base, generation: 0 }],
      ["empty update", { ...base, update: new Uint8Array() }],
      ["oversized update", { ...base, update: new Uint8Array(10 * 1024 * 1024 + 1) }],
      ["blank document", { ...base, documentId: " " }],
      ["oversized document", { ...base, documentId: "가".repeat(86) }],
      ["blank idempotency", { ...base, idempotencyKey: "\u00a0" }],
      ["oversized idempotency", { ...base, idempotencyKey: "가".repeat(86) }],
      ["unknown origin", { ...base, originKind: "unknown" as never }],
      ["blank principal", { ...base, principalId: "\t" }],
      ["oversized principal", { ...base, principalId: "가".repeat(86) }],
      ["blank request", { ...base, requestId: "\n" }],
      ["oversized request", { ...base, requestId: "가".repeat(86) }],
      ["blank session", { ...base, sessionId: "\r" }],
      ["oversized session", { ...base, sessionId: "가".repeat(86) }],
      ["blank action", { ...base, semanticActionId: "\u000b" }],
      ["oversized action", { ...base, semanticActionId: "가".repeat(86) }],
      ["array diagnostic", { ...base, diagnosticJson: [] as never }],
      ["cyclic diagnostic", { ...base, diagnosticJson: cyclic }],
      ["bigint diagnostic", { ...base, diagnosticJson: { secret: BigInt(1) } as never }],
      ["undefined diagnostic", { ...base, diagnosticJson: { secret: undefined } }],
      ["oversized diagnostic", {
        ...base,
        diagnosticJson: { secret: "x".repeat(4 * 1024) },
      }],
    ];

    for (const [label, input] of cases) {
      const failure = await capturePersistenceFailure(() => persistence.appendValidatedUpdate(scope, input));
      expect(failure, label).toMatchObject({ category: "invalid_input", retryable: false });
      expect(failure.message.length, label).toBeLessThanOrEqual(120);
      expect(failure.message, label).not.toMatch(/secret|database/i);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("maps unknown and Aggregate database failures to a bounded parameter-free error", async () => {
    const secret = "document-secret checksum-secret principal-secret json-secret";
    const transaction = vi.fn(() => Promise.reject(new AggregateError([
      new Error(secret),
    ], secret)));
    const persistence = createCollaborationPersistence({
      $client: { transaction },
      transaction,
    } as never, { projectProfile });

    const failure = await capturePersistenceFailure(() => persistence.load(scope, "document-secret"));

    expect(failure).toMatchObject({ category: "internal", retryable: false });
    expect(failure.message.length).toBeLessThanOrEqual(120);
    expect(failure.message).not.toMatch(/document|checksum|principal|json|secret/i);
  });

  it("maps exhausted SQLite contention to a bounded retryable error", async () => {
    const contention = Object.assign(new Error("database locked for document-secret"), {
      code: "SQLITE_BUSY",
    });
    const transaction = vi.fn(() => Promise.reject(contention));
    const persistence = createCollaborationPersistence({
      $client: { transaction },
      transaction,
    } as never, { projectProfile });

    const failure = await capturePersistenceFailure(() => persistence.load(scope, "document-secret"));

    expect(failure).toMatchObject({ category: "contention", retryable: true });
    expect(failure.message.length).toBeLessThanOrEqual(120);
    expect(failure.message).not.toMatch(/document|secret|locked/i);
  });

  it("keeps collaboration records isolated by Workspace", async () => {
    const harness = await createHarness("workspace-isolation");
    await harness.persistence.initialize(scope, harness.documentId);

    await expect(harness.persistence.load(otherScope, harness.documentId)).resolves.toBeNull();
    await expect(harness.persistence.initialize(otherScope, harness.documentId)).rejects.toMatchObject({
      category: "not_found",
      retryable: false,
    });
  });
});

async function createHarness(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-collaboration-${label}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "collaboration.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  const documentId = `document-${label}`;
  await database.insert(documents).values({
    contentJson: paragraphDocument("Legacy body"),
    createdAt: new Date(1_000),
    id: documentId,
    metadataJson: { owner: "Legacy" },
    plainText: "Legacy body",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Legacy title",
    updatedAt: new Date(1_000),
    workspaceId: scope.workspaceId,
  });
  const codec = createCollaborationDocumentCodec(projectProfile);
  return {
    codec,
    database,
    documentId,
    persistence: createCollaborationPersistence(database, { codec, projectProfile }),
  };
}

function appendCommand(
  documentId: string,
  generation: number,
  update: Uint8Array,
  overrides: Partial<AppendCollaborationUpdate> = {},
): AppendCollaborationUpdate {
  return {
    documentId,
    generation,
    idempotencyKey: "append-key",
    originKind: "client",
    principalId: "principal-a",
    requestId: "request-a",
    sessionId: "session-a",
    update,
    ...overrides,
  };
}

function mutateSnapshot(
  snapshot: CollaborationSnapshot,
  mutation: (document: Y.Doc) => void,
) {
  const stateVector = Y.encodeStateVector(snapshot.document);
  snapshot.document.transact(() => mutation(snapshot.document), "test-client");
  return Y.encodeStateAsUpdate(snapshot.document, stateVector);
}

function dependentTitleUpdates(snapshot: CollaborationSnapshot, firstText: string, secondText: string) {
  const title = snapshot.document.getText(COLLABORATION_TITLE_NAME);
  const beforeFirst = Y.encodeStateVector(snapshot.document);
  title.insert(title.length, firstText);
  const first = Y.encodeStateAsUpdate(snapshot.document, beforeFirst);
  const beforeSecond = Y.encodeStateVector(snapshot.document);
  title.insert(title.length, secondText);
  const second = Y.encodeStateAsUpdate(snapshot.document, beforeSecond);
  return { first, second };
}

function dependentInsertDeleteUpdates(snapshot: CollaborationSnapshot, insertedText: string) {
  const title = snapshot.document.getText(COLLABORATION_TITLE_NAME);
  const insertionIndex = title.length;
  const beforeInsertion = Y.encodeStateVector(snapshot.document);
  title.insert(insertionIndex, insertedText);
  const insertion = Y.encodeStateAsUpdate(snapshot.document, beforeInsertion);
  const beforeDeletion = Y.encodeStateVector(snapshot.document);
  title.delete(insertionIndex, insertedText.length);
  const deletion = Y.encodeStateAsUpdate(snapshot.document, beforeDeletion);
  return { deletion, insertion };
}

function replaceTitle(document: Y.Doc, title: string) {
  const sharedTitle = document.getText(COLLABORATION_TITLE_NAME);
  sharedTitle.delete(0, sharedTitle.length);
  sharedTitle.insert(0, title);
}

function paragraphDocument(text: string) {
  return {
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc" as const,
  };
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotIdentity(snapshot: CollaborationSnapshot) {
  return {
    generation: snapshot.generation,
    headSeq: snapshot.headSeq,
    schemaFingerprint: snapshot.schemaFingerprint,
    schemaVersion: snapshot.schemaVersion,
  };
}

async function readLegacyDocument(
  database: Awaited<ReturnType<typeof createHarness>>["database"],
  documentId: string,
) {
  const [document] = await database.select().from(documents).where(and(
    eq(documents.workspaceId, scope.workspaceId),
    eq(documents.id, documentId),
  ));
  if (!document) throw new Error("Expected legacy document");
  return document;
}

async function capturePersistenceFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CollaborationPersistenceError) return error;
    throw error;
  }
  throw new Error("Expected CollaborationPersistenceError");
}
