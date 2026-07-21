import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getSchema } from "@tiptap/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initProseMirrorDoc } from "y-prosemirror";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import * as schema from "@/db/schema";
import {
  aiProposals,
  aiRuns,
  collaborationActions,
  collaborationCommandDeliveryJobs,
  collaborationDocumentChanges,
  collaborationProposalAnchors,
  collaborationUpdates,
  documentChanges,
  documents,
} from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { createServerSchemaExtensions } from "@/plugins/document-schema-profile";
import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";

import { COLLABORATION_BODY_NAME, COLLABORATION_METADATA_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import { createCollaborationPersistence } from "./persistence";
import {
  applyCollaborativeProposalBatch,
  createCollaborativeProposalAnchor,
} from "./proposal-command";
import { createCollaborativeProposalService } from "./proposal-command-service";
import {
  captureCollaborativeInverse,
  createCollaborativeSelectiveUndoService,
  verifyCollaborativeUndoTarget,
} from "./selective-undo";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const profile = getProjectProfile("default");
const codec = createCollaborationDocumentCodec(profile);
const prosemirrorSchema = getSchema(createServerSchemaExtensions(appDocumentSchemaProfileRuntime));
const clients: Client[] = [];
const tempDirs: string[] = [];
const scope = { workspaceId: "workspace-undo" };
const context = {
  ...scope,
  authMode: "test" as const,
  principalId: "principal-undo",
  requestId: "request-undo",
  role: "owner" as const,
};

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("collaborative inverse capture", () => {
  it("restores the exact pre-command body after encode, reload, and garbage collection", () => {
    const base = createDocument("alpha beta gamma");
    const baseState = Y.encodeStateAsUpdate(base);
    const expectedBaseBody = bodyJson(base);
    const anchor = anchorFor(base, 7, 11);
    const working = codec.loadCheckpoint(baseState);
    const before = Y.encodeStateVector(working);
    const applied = applyCollaborativeProposalBatch(working, identity(working), [{
      anchor,
      mode: "replace",
      proposalId: "proposal-inverse",
      replacementText: "BETTER",
    }]);
    if (!applied.ok) throw new Error("forward apply failed");
    const forwardUpdate = Y.encodeStateAsUpdate(working, before);

    expect(applied.changedRange).toEqual({ from: 7, to: 13 });
    const capture = captureCollaborativeInverse({
      baseState,
      changedRange: applied.changedRange,
      forwardUpdate,
    });
    if (!capture.ok) throw new Error("inverse capture failed");
    expect(capture.inverse.inverseUpdate.byteLength).toBeGreaterThan(0);
    expect(capture.inverse.postconditionFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The captured forward and inverse survive full encode/reload with GC on.
    const reloaded = new Y.Doc({ gc: true });
    Y.applyUpdate(reloaded, baseState);
    Y.applyUpdate(reloaded, forwardUpdate);
    const persisted = Y.encodeStateAsUpdate(reloaded);
    const restarted = new Y.Doc({ gc: true });
    Y.applyUpdate(restarted, persisted);
    expect(bodyText(restarted)).toBe("alpha BETTER gamma");

    Y.applyUpdate(restarted, capture.inverse.inverseUpdate);
    expect(bodyJson(restarted)).toEqual(expectedBaseBody);

    const recompacted = new Y.Doc({ gc: true });
    Y.applyUpdate(recompacted, Y.encodeStateAsUpdate(restarted));
    expect(bodyJson(recompacted)).toEqual(expectedBaseBody);
    base.destroy();
    working.destroy();
    reloaded.destroy();
    restarted.destroy();
    recompacted.destroy();
  });

  it("keeps unrelated concurrent edits while undoing only the affected range", () => {
    const scenario = capturedForwardScenario();

    firstXmlText(scenario.document).insert(0, "preface ");

    const verified = verifyCollaborativeUndoTarget(scenario.document, scenario.inverse);
    expect(verified).toMatchObject({ ok: true });
    Y.applyUpdate(scenario.document, scenario.inverse.inverseUpdate);
    expect(bodyText(scenario.document)).toBe("preface alpha beta gamma");
    scenario.document.destroy();
  });

  it("rejects undo when the affected range itself changed", () => {
    const scenario = capturedForwardScenario();

    firstXmlText(scenario.document).insert(8, "X");

    expect(verifyCollaborativeUndoTarget(scenario.document, scenario.inverse))
      .toEqual({ ok: false, reason: "undo_conflict" });
    scenario.document.destroy();
  });

  it("fails closed when the forward update never touched the collaborative body", () => {
    const base = createDocument("alpha beta gamma");
    const baseState = Y.encodeStateAsUpdate(base);
    const working = codec.loadCheckpoint(baseState);
    const before = Y.encodeStateVector(working);
    working.getMap(COLLABORATION_METADATA_NAME).set("category", "memo");
    const forwardUpdate = Y.encodeStateAsUpdate(working, before);

    expect(captureCollaborativeInverse({
      baseState,
      changedRange: { from: 7, to: 13 },
      forwardUpdate,
    })).toEqual({ ok: false, reason: "inverse_capture_failed" });
    base.destroy();
    working.destroy();
  });
});

describe("collaborative selective undo service", () => {
  it("stores the exact executable inverse during collaborative Proposal apply", async () => {
    const harness = await createHarness("store-inverse");
    const proposal = await harness.seedProposal("proposal-store", { from: 7, replacementText: "BETTER", to: 11 });

    await expect(harness.proposalService.apply(context, {
      commandId: "command-store-inverse",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    })).resolves.toMatchObject({ ok: true });

    const [change] = await harness.database.select().from(documentChanges);
    const [action] = await harness.database.select().from(collaborationActions);
    const [stored] = await harness.database.select().from(collaborationDocumentChanges);
    expect(stored).toMatchObject({
      actionId: action!.id,
      baseHeadSeq: 0,
      changeId: change!.id,
      documentId: harness.documentId,
      forwardSeq: 1,
      generation: 1,
      resultingHeadSeq: 1,
      workspaceId: scope.workspaceId,
    });
    expect(stored!.postconditionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.inverseUpdate.byteLength).toBeGreaterThan(0);
    expect(stored!.affectedStartRelative.byteLength).toBeGreaterThan(0);
    expect(stored!.affectedEndRelative.byteLength).toBeGreaterThan(0);
  });

  it("undoes a change exactly, keeps unrelated later edits, and never executes the audit snapshot", async () => {
    const harness = await createHarness("exact-undo");
    const proposal = await harness.seedProposal("proposal-exact", { from: 7, replacementText: "BETTER", to: 11 });
    await harness.proposalService.apply(context, {
      commandId: "command-exact-apply",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    });
    await harness.appendPeerEdit("peer-preface", (text) => text.insert(0, "preface "));
    const [change] = await harness.database.select().from(documentChanges);
    await harness.database.update(documentChanges).set({
      beforeSnapshotJson: {
        contentJson: { content: [{ content: [{ text: "POISON", type: "text" }], type: "paragraph" }], type: "doc" },
        metadataJson: {},
        readiness: "draft",
        title: "POISON",
      },
    }).where(eq(documentChanges.id, change!.id));

    const result = await harness.undoService.undo(context, {
      changeId: change!.id,
      commandId: "command-exact-undo",
      observedHeadSeq: 2,
    });

    expect(result).toMatchObject({
      collaboration: { generation: 1, headSeq: 3 },
      ok: true,
      proposals: [{ appliedMode: null, id: proposal.id, status: "pending" }],
      replayed: false,
    });
    if (!result.ok) throw new Error("undo failed");
    expect(result.change.undoneAt).not.toBeNull();
    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(harness.codec.materialize(loaded!.document).plainText).toBe("preface alpha beta gamma");
    const [projected] = await harness.database.select().from(documents);
    expect(projected!.plainText).toBe("preface alpha beta gamma");
    expect(JSON.stringify(projected!.contentJson)).not.toContain("POISON");
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({ seq: 1, status: "pending" }),
      expect.objectContaining({ seq: 3, status: "pending" }),
    ]);
    await expect(harness.database.select().from(collaborationActions).where(
      eq(collaborationActions.actionType, "selective_undo"),
    )).resolves.toEqual([
      expect.objectContaining({
        appliedHeadSeq: 3,
        commandId: "command-exact-undo",
        documentChangeId: change!.id,
        status: "applied",
      }),
    ]);
  });

  it("returns undo_conflict without mutation when an edit landed inside the affected range", async () => {
    const harness = await createHarness("undo-conflict");
    const proposal = await harness.seedProposal("proposal-conflict", { from: 7, replacementText: "BETTER", to: 11 });
    await harness.proposalService.apply(context, {
      commandId: "command-conflict-apply",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    });
    await harness.appendPeerEdit("peer-inside", (text) => text.insert(8, "X"));
    const [change] = await harness.database.select().from(documentChanges);
    const updatesBefore = await harness.database.select().from(collaborationUpdates);

    await expect(harness.undoService.undo(context, {
      changeId: change!.id,
      commandId: "command-conflict-undo",
      observedHeadSeq: 2,
    })).resolves.toEqual({ ok: false, reason: "undo_conflict" });

    await expect(harness.database.select().from(aiProposals)).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, status: "accepted" }),
    ]);
    const [unchangedChange] = await harness.database.select().from(documentChanges);
    expect(unchangedChange!.undoneAt).toBeNull();
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(updatesBefore.length);
    await expect(harness.database.select().from(collaborationActions).where(
      eq(collaborationActions.actionType, "selective_undo"),
    )).resolves.toEqual([]);
  });

  it("undoes an applied batch atomically and rejects it atomically after an inside edit", async () => {
    const atomic = await createHarness("batch-atomic");
    const atomicFirst = await atomic.seedProposal("proposal-batch-one", { from: 1, replacementText: "ONE", to: 6 });
    const atomicSecond = await atomic.seedProposal("proposal-batch-two", { from: 12, replacementText: "TWO", to: 17 });
    await atomic.proposalService.apply(context, {
      commandId: "command-batch-apply",
      items: [
        { mode: "replace", proposalId: atomicFirst.id },
        { mode: "replace", proposalId: atomicSecond.id },
      ],
      observedHeadSeq: 0,
    });
    const [atomicChange] = await atomic.database.select().from(documentChanges);

    await expect(atomic.undoService.undo(context, {
      changeId: atomicChange!.id,
      commandId: "command-batch-undo",
      observedHeadSeq: 1,
    })).resolves.toMatchObject({ ok: true });
    const atomicLoaded = await atomic.persistence.load(scope, atomic.documentId);
    expect(atomic.codec.materialize(atomicLoaded!.document).plainText).toBe("alpha beta gamma");
    expect((await atomic.database.select().from(aiProposals)).map(({ status }) => status))
      .toEqual(["pending", "pending"]);

    const conflicted = await createHarness("batch-conflict");
    const conflictedFirst = await conflicted.seedProposal("proposal-batch-three", { from: 1, replacementText: "ONE", to: 6 });
    const conflictedSecond = await conflicted.seedProposal("proposal-batch-four", { from: 12, replacementText: "TWO", to: 17 });
    await conflicted.proposalService.apply(context, {
      commandId: "command-batch-conflict-apply",
      items: [
        { mode: "replace", proposalId: conflictedFirst.id },
        { mode: "replace", proposalId: conflictedSecond.id },
      ],
      observedHeadSeq: 0,
    });
    await conflicted.appendPeerEdit("peer-inside-batch", (text) => text.insert(10, "X"));
    const [conflictedChange] = await conflicted.database.select().from(documentChanges);

    await expect(conflicted.undoService.undo(context, {
      changeId: conflictedChange!.id,
      commandId: "command-batch-conflict-undo",
      observedHeadSeq: 2,
    })).resolves.toEqual({ ok: false, reason: "undo_conflict" });
    expect((await conflicted.database.select().from(aiProposals)).map(({ status }) => status))
      .toEqual(["accepted", "accepted"]);
    const [conflictedUnchanged] = await conflicted.database.select().from(documentChanges);
    expect(conflictedUnchanged!.undoneAt).toBeNull();
  });

  it("replays a duplicate undo command and fails closed on identity reuse", async () => {
    const harness = await createHarness("undo-idempotency");
    const proposal = await harness.seedProposal("proposal-idempotent", { from: 7, replacementText: "BETTER", to: 11 });
    await harness.proposalService.apply(context, {
      commandId: "command-idempotent-apply",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    });
    const [change] = await harness.database.select().from(documentChanges);
    const input = {
      changeId: change!.id,
      commandId: "command-idempotent-undo",
      observedHeadSeq: 1,
    };

    const first = await harness.undoService.undo(context, input);
    const replay = await harness.undoService.undo({ ...context, requestId: "request-undo-retry" }, input);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({
      collaboration: { generation: 1, headSeq: 2 },
      ok: true,
      proposals: [{ id: proposal.id, status: "pending" }],
      replayed: true,
    });
    await expect(harness.undoService.undo(context, {
      ...input,
      commandId: "command-second-undo",
    })).resolves.toEqual({ ok: false, reason: "undo_conflict" });
    await expect(harness.undoService.undo(
      { ...context, principalId: "principal-other" },
      input,
    )).resolves.toEqual({ ok: false, reason: "idempotency_conflict" });
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(2);
  });

  it("preserves the stored inverse across checkpoint compaction and restart", async () => {
    const harness = await createHarness("undo-restart");
    const proposal = await harness.seedProposal("proposal-restart", { from: 7, replacementText: "BETTER", to: 11 });
    await harness.proposalService.apply(context, {
      commandId: "command-restart-apply",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    });
    await harness.persistence.checkpoint(scope, harness.documentId, 1);
    const [change] = await harness.database.select().from(documentChanges);

    const restartedCodec = createCollaborationDocumentCodec(profile);
    const restartedPersistence = createCollaborationPersistence(harness.database, {
      codec: restartedCodec,
      projectProfile: profile,
    });
    const restartedService = createCollaborativeSelectiveUndoService({
      database: harness.database,
      persistence: restartedPersistence,
    });

    await expect(restartedService.undo(context, {
      changeId: change!.id,
      commandId: "command-restart-undo",
      observedHeadSeq: 1,
    })).resolves.toMatchObject({ ok: true, replayed: false });
    const loaded = await restartedPersistence.load(scope, harness.documentId);
    expect(restartedCodec.materialize(loaded!.document).plainText).toBe("alpha beta gamma");
    await expect(harness.database.select().from(aiProposals)).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, status: "pending" }),
    ]);
  });

  it("rejects unknown changes, changes without a stored inverse, and malformed input", async () => {
    const harness = await createHarness("undo-guards");
    await expect(harness.undoService.undo(context, {
      changeId: "change-missing",
      commandId: "command-missing-change",
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "not_found" });

    const timestamp = new Date(2_000);
    await harness.database.insert(documentChanges).values({
      afterRevision: 1,
      batchId: null,
      beforeSnapshotJson: {
        contentJson: { content: [], type: "doc" },
        metadataJson: {},
        readiness: "draft",
        title: "Legacy",
      },
      createdAt: timestamp,
      documentId: harness.documentId,
      id: "change-legacy",
      kind: "single",
      principalId: context.principalId,
      requestId: context.requestId,
      workspaceId: scope.workspaceId,
    });
    await expect(harness.undoService.undo(context, {
      changeId: "change-legacy",
      commandId: "command-legacy-change",
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "undo_conflict" });

    await expect(harness.undoService.undo(context, {
      changeId: "change-legacy",
      commandId: "invalid command id",
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "invalid_request" });
  });
});

function capturedForwardScenario() {
  const base = createDocument("alpha beta gamma");
  const baseState = Y.encodeStateAsUpdate(base);
  const anchor = anchorFor(base, 7, 11);
  base.destroy();
  const document = codec.loadCheckpoint(baseState);
  const before = Y.encodeStateVector(document);
  const applied = applyCollaborativeProposalBatch(document, identity(document), [{
    anchor,
    mode: "replace",
    proposalId: "proposal-scenario",
    replacementText: "BETTER",
  }]);
  if (!applied.ok) throw new Error("forward apply failed");
  const forwardUpdate = Y.encodeStateAsUpdate(document, before);
  const capture = captureCollaborativeInverse({
    baseState,
    changedRange: applied.changedRange,
    forwardUpdate,
  });
  if (!capture.ok) throw new Error("inverse capture failed");
  return { document, inverse: capture.inverse };
}

function createDocument(text: string) {
  return codec.bootstrap({
    contentJson: { content: [{ content: [{ text, type: "text" }], type: "paragraph" }], type: "doc" },
    metadataJson: {},
    plainText: text,
    title: "Selective undo",
  });
}

function identity(document: Y.Doc) {
  return {
    generation: 1,
    headSeq: 0,
    schemaFingerprint: codec.fingerprint(),
    stateVector: Y.encodeStateVector(document),
  };
}

function anchorFor(document: Y.Doc, from: number, to: number) {
  return createCollaborativeProposalAnchor(document, {
    baseHeadSeq: 0,
    generation: 1,
    range: { from, to },
    schemaFingerprint: codec.fingerprint(),
  });
}

function bodyJson(document: Y.Doc) {
  const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  return initProseMirrorDoc(body, prosemirrorSchema).doc.toJSON();
}

function bodyText(document: Y.Doc) {
  const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  const prosemirrorDocument = initProseMirrorDoc(body, prosemirrorSchema).doc;
  return prosemirrorDocument.textBetween(0, prosemirrorDocument.content.size, " ", "￼");
}

function firstXmlText(document: Y.Doc): Y.XmlText {
  const queue: Array<Y.XmlElement | Y.XmlFragment> = [document.getXmlFragment(COLLABORATION_BODY_NAME)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of current.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) queue.push(child);
    }
  }
  throw new Error("Expected collaborative text");
}

async function createHarness(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `coredot-selective-undo-${label}-`));
  tempDirs.push(directory);
  const client = createClient({ url: `file:${join(directory, "undo.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  const documentId = `document-${label}`;
  const timestamp = new Date(1_000);
  await database.insert(documents).values({
    contentJson: { content: [{ content: [{ text: "alpha beta gamma", type: "text" }], type: "paragraph" }], type: "doc" },
    createdAt: timestamp,
    id: documentId,
    metadataJson: {},
    plainText: "alpha beta gamma",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Selective undo",
    updatedAt: timestamp,
    workspaceId: scope.workspaceId,
  });
  const harnessCodec = createCollaborationDocumentCodec(profile);
  const persistence = createCollaborationPersistence(database, {
    codec: harnessCodec,
    projectProfile: profile,
  });
  const initial = await persistence.initialize(scope, documentId);
  await database.insert(aiRuns).values({
    commandType: "document_review",
    createdAt: timestamp,
    documentId,
    errorMessage: null,
    executionToken: null,
    id: `run-${label}`,
    idempotencyKey: `run-key-${label}`,
    inputSummaryJson: {},
    model: "stub-editor",
    operationFingerprint: "a".repeat(64),
    outputText: "",
    provider: "stub",
    retryNotBeforeAt: null,
    status: "completed",
    updatedAt: timestamp,
    wasApplied: false,
    workspaceId: scope.workspaceId,
  });
  const proposalService = createCollaborativeProposalService({ database, persistence });
  const undoService = createCollaborativeSelectiveUndoService({ database, persistence });
  return {
    codec: harnessCodec,
    database,
    documentId,
    persistence,
    proposalService,
    undoService,
    async appendPeerEdit(idempotencyKey: string, edit: (text: Y.XmlText) => void) {
      const current = await persistence.load(scope, documentId);
      if (!current) throw new Error("missing collaboration document");
      const before = Y.encodeStateVector(current.document);
      edit(firstXmlText(current.document));
      return persistence.appendValidatedUpdate(scope, {
        documentId,
        generation: current.generation,
        idempotencyKey,
        originKind: "client",
        principalId: "principal-peer",
        requestId: "request-peer",
        sessionId: "session-peer",
        update: Y.encodeStateAsUpdate(current.document, before),
      });
    },
    async seedProposal(
      proposalId: string,
      input: { from: number; replacementText: string; to: number },
    ) {
      const targetText = harnessCodec.materialize(initial.document).plainText
        .slice(input.from - 1, input.to - 1);
      const [proposal] = await database.insert(aiProposals).values({
        aiRunId: `run-${label}`,
        createdAt: timestamp,
        documentId,
        explanation: "Improve text",
        id: proposalId,
        replacementText: input.replacementText,
        resultOrdinal: Number((await database.select().from(aiProposals)).length),
        source: "review",
        status: "pending",
        targetFrom: input.from,
        targetText,
        targetTo: input.to,
        updatedAt: timestamp,
        workspaceId: scope.workspaceId,
      }).returning();
      const anchor = createCollaborativeProposalAnchor(initial.document, {
        baseHeadSeq: initial.headSeq,
        generation: initial.generation,
        range: { from: input.from, to: input.to },
        schemaFingerprint: initial.schemaFingerprint,
      });
      await database.insert(collaborationProposalAnchors).values({
        ...anchor,
        baseStateVector: Buffer.from(anchor.baseStateVector),
        createdAt: timestamp,
        documentId,
        endRelative: Buffer.from(anchor.endRelative),
        proposalId,
        startRelative: Buffer.from(anchor.startRelative),
        workspaceId: scope.workspaceId,
      });
      return proposal!;
    },
  };
}
