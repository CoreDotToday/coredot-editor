import { createClient, type Client } from "@libsql/client";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { aiProposals, documentChangeProposals, documentChanges, documents, type TiptapJson } from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { DOCUMENT_REQUEST_BODY_BYTES } from "@/features/security/resource-policy";
import { createDocumentChangeService } from "./document-change-service";
import { extractPlainTextFromTiptap } from "./tiptap-text";

const clients: Client[] = [];
const tempDirs: string[] = [];
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const context: RequestContext = {
  authMode: "test",
  principalId: "principal_a",
  requestId: "request_a",
  role: "owner",
  workspaceId: "workspace_a",
};

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function content(text: string): TiptapJson {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function draft(text: string) {
  return {
    title: "Dirty draft",
    contentJson: content(text),
    metadataJson: { owner: "Principal A" },
    readiness: "needs_review" as const,
  };
}

async function createChangeDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-document-change-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "changes.db")}` });
  clients.push(client);
  const db = drizzle(client, { schema });
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      creation_key text,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      readiness text DEFAULT 'draft' NOT NULL,
      metadata_json text DEFAULT '{}' NOT NULL,
      revision integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX documents_workspace_id_id_unique ON documents(workspace_id, id);
    CREATE UNIQUE INDEX documents_workspace_creation_key_unique ON documents(workspace_id, creation_key);
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      ai_run_id text NOT NULL,
      document_id text NOT NULL,
      target_text text NOT NULL,
      replacement_text text NOT NULL,
      explanation text NOT NULL,
      source text DEFAULT 'review' NOT NULL,
      command text,
      occurrence_index integer,
      target_from integer,
      target_to integer,
      default_apply_mode text DEFAULT 'replace' NOT NULL,
      applied_mode text,
      status text DEFAULT 'pending' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX ai_proposals_workspace_id_id_document_id_unique
      ON ai_proposals(workspace_id, id, document_id);
    CREATE TABLE document_changes (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      principal_id text NOT NULL,
      request_id text NOT NULL,
      kind text NOT NULL,
      batch_id text,
      before_snapshot_json text NOT NULL,
      after_revision integer NOT NULL,
      created_at integer NOT NULL,
      undone_at integer,
      CONSTRAINT document_changes_workspace_document_fk FOREIGN KEY(workspace_id, document_id)
        REFERENCES documents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX document_changes_workspace_id_document_unique
      ON document_changes(workspace_id, id, document_id);
    CREATE TABLE document_change_proposals (
      workspace_id text NOT NULL,
      change_id text NOT NULL,
      document_id text NOT NULL,
      proposal_id text NOT NULL,
      applied_mode text NOT NULL,
      ordinal integer NOT NULL,
      PRIMARY KEY(workspace_id, change_id, proposal_id),
      CONSTRAINT document_change_proposals_change_fk FOREIGN KEY(workspace_id, change_id, document_id)
        REFERENCES document_changes(workspace_id, id, document_id) ON DELETE CASCADE,
      CONSTRAINT document_change_proposals_proposal_fk FOREIGN KEY(workspace_id, proposal_id, document_id)
        REFERENCES ai_proposals(workspace_id, id, document_id) ON DELETE CASCADE
    );
  `);
  return db;
}

async function seedDocument(db: Awaited<ReturnType<typeof createChangeDatabase>>, workspaceId = context.workspaceId) {
  await db.insert(documents).values({
    id: "doc_1",
    workspaceId,
    title: "Persisted title",
    contentJson: content("persisted server text"),
    plainText: "persisted server text",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  });
}

async function seedProposal(
  db: Awaited<ReturnType<typeof createChangeDatabase>>,
  input: { id: string; replacement: string; target: string; workspaceId?: string },
) {
  await db.insert(aiProposals).values({
    id: input.id,
    workspaceId: input.workspaceId ?? context.workspaceId,
    aiRunId: `run_${input.id}`,
    documentId: "doc_1",
    targetText: input.target,
    replacementText: input.replacement,
    explanation: "Document change test",
    source: "review",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  });
}

describe("document change service", () => {
  it("applies one proposal to the submitted dirty draft and audits its principal and proposal", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "revenue grew 8%", target: "growth was good" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("local unsaved preface; growth was good"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });

    expect(result).toMatchObject({
      ok: true,
      change: {
        afterRevision: 1,
        documentId: "doc_1",
        kind: "single",
        principalId: "principal_a",
        requestId: "request_a",
        workspaceId: "workspace_a",
      },
      document: { revision: 1, title: "Dirty draft" },
      proposals: [{ appliedMode: "replace", id: "proposal_1", status: "accepted" }],
    });
    if (!result.ok) return;
    expect(extractPlainTextFromTiptap(result.document.contentJson)).toBe("local unsaved preface; revenue grew 8%");
    const [link] = await db.select().from(documentChangeProposals);
    expect(link).toMatchObject({ proposalId: "proposal_1", appliedMode: "replace", ordinal: 0 });
  });

  it("returns the latest document and changes nothing when expected revision is stale", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await db.update(documents).set({ revision: 1 }).where(eq(documents.id, "doc_1"));
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });

    expect(result).toMatchObject({ ok: false, reason: "revision_conflict", document: { revision: 1 } });
    expect(await db.select().from(documentChanges)).toHaveLength(0);
    expect(await db.select().from(aiProposals)).toMatchObject([{ status: "pending" }]);
  });

  it("rolls back every proposal when one bulk target is stale", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_2", replacement: "B", target: "missing" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_1" },
        { mode: "replace", proposalId: "proposal_2" },
      ],
    });

    expect(result).toMatchObject({ ok: false, reason: "proposal_apply_failed" });
    expect((await db.select().from(aiProposals).orderBy(asc(aiProposals.id))).map(({ status }) => status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(await db.select().from(documentChanges)).toHaveLength(0);
    expect(await db.select().from(documentChangeProposals)).toHaveLength(0);
    expect(await db.select().from(documents)).toMatchObject([{ plainText: "persisted server text", revision: 0 }]);
  });

  it("rejects duplicate proposal ids before a bulk transaction", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_1" },
        { mode: "insert_below", proposalId: "proposal_1" },
      ],
    });

    expect(result).toEqual({ ok: false, reason: "invalid_batch" });
    expect(await db.select().from(documentChanges)).toHaveLength(0);
  });

  it("rejects non-pending, mismatched, and cross-workspace proposals without revealing them", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "accepted", replacement: "new", target: "target" });
    await db.update(aiProposals).set({ status: "accepted" }).where(eq(aiProposals.id, "accepted"));
    await db.insert(documents).values({
      id: "doc_2",
      workspaceId: context.workspaceId,
      title: "Other",
      contentJson: content("target"),
      plainText: "target",
      status: "draft",
      readiness: "draft",
      metadataJson: {},
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    });
    await seedProposal(db, { id: "mismatched", replacement: "new", target: "target" });
    await db.update(aiProposals).set({ documentId: "doc_2" }).where(eq(aiProposals.id, "mismatched"));
    const changes = createDocumentChangeService(db);

    await expect(changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "accepted",
      mode: "replace",
    })).resolves.toMatchObject({ ok: false, reason: "status_conflict" });
    await expect(changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "mismatched",
      mode: "replace",
    })).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(changes.applyProposal({ ...context, workspaceId: "workspace_b" }, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "accepted",
      mode: "replace",
    })).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("applies a bulk batch in one document revision and one audited change", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_2", replacement: "B", target: "beta" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_1" },
        { mode: "replace", proposalId: "proposal_2" },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      change: { afterRevision: 1, kind: "batch" },
      document: { plainText: "A B", revision: 1 },
      proposals: [{ status: "accepted" }, { status: "accepted" }],
    });
    expect(await db.select().from(documentChanges)).toHaveLength(1);
    expect(await db.select().from(documentChangeProposals)).toHaveLength(2);
  });

  it("audits range-backed proposals in their final server application order", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_early", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_late", replacement: "B", target: "beta" });
    await db.update(aiProposals).set({ source: "selection", targetFrom: 1, targetTo: 6 })
      .where(eq(aiProposals.id, "proposal_early"));
    await db.update(aiProposals).set({ source: "selection", targetFrom: 7, targetTo: 11 })
      .where(eq(aiProposals.id, "proposal_late"));
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_early" },
        { mode: "replace", proposalId: "proposal_late" },
      ],
    });

    expect(result).toMatchObject({ ok: true, document: { plainText: "A B" } });
    const links = await db.select().from(documentChangeProposals).orderBy(asc(documentChangeProposals.ordinal));
    expect(links.map(({ ordinal, proposalId }) => ({ ordinal, proposalId }))).toEqual([
      { ordinal: 0, proposalId: "proposal_late" },
      { ordinal: 1, proposalId: "proposal_early" },
    ]);
  });

  it("lists tenant-scoped document changes with stable cursor pagination", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_2", replacement: "B", target: "beta" });
    const changes = createDocumentChangeService(db);
    const first = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });
    const second = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("A beta"),
      expectedRevision: 1,
      proposalId: "proposal_2",
      mode: "replace",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    await db.update(documentChanges).set({ createdAt: new Date("2026-01-01T00:00:01.000Z") })
      .where(eq(documentChanges.id, first.change.id));
    await db.update(documentChanges).set({ createdAt: new Date("2026-01-01T00:00:02.000Z") })
      .where(eq(documentChanges.id, second.change.id));
    await db.run(sql`UPDATE document_changes SET before_snapshot_json = 'not-json'`);

    const firstPage = await changes.list(context, { documentId: "doc_1", limit: 1 });
    const secondPage = await changes.list(context, {
      documentId: "doc_1",
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const otherWorkspace = await changes.list(
      { ...context, principalId: "principal_b", workspaceId: "workspace_b" },
      { documentId: "doc_1", limit: 10 },
    );

    expect(firstPage).toMatchObject({
      changes: [{ id: second.change.id, proposals: [{ id: "proposal_2", ordinal: 0 }] }],
      nextCursor: second.change.id,
    });
    expect(secondPage).toMatchObject({
      changes: [{ id: first.change.id, proposals: [{ id: "proposal_1", ordinal: 0 }] }],
      nextCursor: null,
    });
    expect(otherWorkspace).toEqual({ changes: [], nextCursor: null });
  });

  it("lists one durable history item for a bulk document change", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_2", replacement: "B", target: "beta" });
    const changes = createDocumentChangeService(db);
    const applied = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_1" },
        { mode: "replace", proposalId: "proposal_2" },
      ],
    });
    expect(applied.ok).toBe(true);
    await db.update(aiProposals).set({
      targetText: "😀".repeat(1_000),
      replacementText: "😀".repeat(2_000),
    });

    const history = await changes.list(context, { documentId: "doc_1", limit: 10 });

    expect(history.changes).toHaveLength(1);
    expect(history.changes[0]).toMatchObject({
      kind: "batch",
      proposals: [
        { id: "proposal_1", ordinal: 0 },
        { id: "proposal_2", ordinal: 1 },
      ],
    });
    expect(history.changes[0]?.proposals.every((proposal) => proposal.targetText.length === 200)).toBe(true);
    expect(history.changes[0]?.proposals.every((proposal) => proposal.replacementText.length === 500)).toBe(true);
  });

  it("audits an explicitly requested one-item batch as a batch", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);

    const result = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposals: [{ mode: "replace", proposalId: "proposal_1" }],
    });

    expect(result).toMatchObject({ ok: true, change: { kind: "batch", batchId: expect.any(String) } });
  });

  it("rejects unsafe revisions and oversized batches before database access", async () => {
    const db = await createChangeDatabase();
    const changes = createDocumentChangeService(db);
    const input = {
      documentId: "doc_1",
      draft: draft("target"),
      proposals: [{ mode: "replace" as const, proposalId: "proposal_1" }],
    };

    await expect(changes.applyProposalBatch(context, { ...input, expectedRevision: -1 }))
      .resolves.toEqual({ ok: false, reason: "invalid_revision" });
    await expect(changes.applyProposalBatch(context, { ...input, expectedRevision: 1.5 }))
      .resolves.toEqual({ ok: false, reason: "invalid_revision" });
    await expect(changes.undo(context, { changeId: "change_1", expectedRevision: -1 }))
      .resolves.toEqual({ ok: false, reason: "invalid_revision" });
    await expect(changes.undo(context, { changeId: "change_1", expectedRevision: 1.5 }))
      .resolves.toEqual({ ok: false, reason: "invalid_revision" });
    await expect(changes.applyProposalBatch(context, {
      ...input,
      expectedRevision: 0,
      proposals: Array.from({ length: 101 }, (_, index) => ({
        mode: "replace" as const,
        proposalId: `proposal_${String(index)}`,
      })),
    })).resolves.toEqual({ ok: false, reason: "invalid_batch" });
  });

  it("undoes the document and every linked proposal atomically", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "A", target: "alpha" });
    await seedProposal(db, { id: "proposal_2", replacement: "B", target: "beta" });
    const changes = createDocumentChangeService(db);
    const applied = await changes.applyProposalBatch(context, {
      documentId: "doc_1",
      draft: draft("alpha beta"),
      expectedRevision: 0,
      proposals: [
        { mode: "replace", proposalId: "proposal_1" },
        { mode: "replace", proposalId: "proposal_2" },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const undone = await changes.undo(context, { changeId: applied.change.id, expectedRevision: 1 });

    expect(undone).toMatchObject({
      ok: true,
      change: { id: applied.change.id },
      document: {
        contentJson: content("alpha beta"),
        metadataJson: { owner: "Principal A" },
        readiness: "needs_review",
        revision: 2,
        title: "Dirty draft",
      },
      proposals: [{ appliedMode: null, status: "pending" }, { appliedMode: null, status: "pending" }],
    });
    expect(undone.ok && undone.change.undoneAt).toBeInstanceOf(Date);
  });

  it("does not undo against a stale current revision", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);
    const applied = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const result = await changes.undo(context, { changeId: applied.change.id, expectedRevision: 0 });

    expect(result).toMatchObject({ ok: false, reason: "revision_conflict", document: { revision: 1 } });
    expect(await db.select().from(aiProposals)).toMatchObject([{ appliedMode: "replace", status: "accepted" }]);
    expect(await db.select().from(documentChanges)).toMatchObject([{ undoneAt: null }]);
  });

  it("allows each persisted change to be undone only once", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);
    const applied = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect((await changes.undo(context, { changeId: applied.change.id, expectedRevision: 1 })).ok).toBe(true);

    const secondUndo = await changes.undo(context, { changeId: applied.change.id, expectedRevision: 2 });

    expect(secondUndo).toMatchObject({ ok: false, reason: "status_conflict" });
    expect(await db.select().from(documents)).toMatchObject([{ plainText: "target", revision: 2 }]);
  });

  it("rejects undo atomically when a linked proposal no longer has its accepted mode", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);
    const applied = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    await db.update(aiProposals).set({ appliedMode: "insert_below" }).where(eq(aiProposals.id, "proposal_1"));

    const result = await changes.undo(context, { changeId: applied.change.id, expectedRevision: 1 });

    expect(result).toMatchObject({ ok: false, reason: "status_conflict" });
    expect(await db.select().from(documents)).toMatchObject([{ plainText: "new", revision: 1 }]);
    expect(await db.select().from(documentChanges)).toMatchObject([{ undoneAt: null }]);
  });

  it("rejects an unbounded or malformed submitted draft before opening a change", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);
    let nested: Record<string, unknown> = { type: "paragraph" };
    for (let depth = 0; depth < 70; depth += 1) nested = { type: "blockquote", content: [nested] };

    const result = await changes.applyProposal(context, {
      documentId: "doc_1",
      draft: { ...draft("target"), contentJson: { type: "doc", content: [nested] } as TiptapJson },
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_draft", limit: "documentDepth" });
    expect(await db.select().from(documentChanges)).toHaveLength(0);
  });

  it("bounds the full audit snapshot including title and metadata", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    const changes = createDocumentChangeService(db);
    const base = {
      documentId: "doc_1",
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace" as const,
    };

    await expect(changes.applyProposal(context, {
      ...base,
      draft: { ...draft("target"), title: "x".repeat(501) },
    })).resolves.toMatchObject({ ok: false, reason: "invalid_draft", limit: "title" });
    await expect(changes.applyProposal(context, {
      ...base,
      draft: { ...draft("target"), metadataJson: { oversized: "x".repeat(DOCUMENT_REQUEST_BODY_BYTES) } },
    })).resolves.toMatchObject({ ok: false, reason: "invalid_draft", limit: "snapshotBytes" });
    expect(await db.select().from(documentChanges)).toHaveLength(0);
  });

  it("rolls back document and proposal mutations when audit persistence fails", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db);
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target" });
    await db.run(sql`
      CREATE TRIGGER fail_document_change_audit
      BEFORE INSERT ON document_changes
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END
    `);
    const changes = createDocumentChangeService(db);

    await expect(changes.applyProposal(context, {
      documentId: "doc_1",
      draft: draft("target"),
      expectedRevision: 0,
      proposalId: "proposal_1",
      mode: "replace",
    })).rejects.toThrow();
    expect(await db.select().from(documents)).toMatchObject([{ plainText: "persisted server text", revision: 0 }]);
    expect(await db.select().from(aiProposals)).toMatchObject([{ appliedMode: null, status: "pending" }]);
  });

  it("does not reveal another workspace's change during undo", async () => {
    const db = await createChangeDatabase();
    await seedDocument(db, "workspace_b");
    await seedProposal(db, { id: "proposal_1", replacement: "new", target: "target", workspaceId: "workspace_b" });
    const changes = createDocumentChangeService(db);

    const result = await changes.undo(context, { changeId: "missing", expectedRevision: 0 });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
