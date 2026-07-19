import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { defineProjectProfile } from "@/features/projects/project-profile";
import { createDocumentRepository } from "./document-repository";

const tempDirs: string[] = [];
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedDocumentDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-document-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "documents.db")}` });
  const db = drizzle(client, { schema });

  await db.run(sql`
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
      updated_at integer NOT NULL,
      CONSTRAINT "documents_status_check" CHECK(status in ('draft', 'archived')),
      CONSTRAINT "documents_readiness_check" CHECK(readiness in ('draft', 'needs_review', 'ready', 'approved'))
    )
  `);
  await db.run(sql`
    CREATE UNIQUE INDEX documents_workspace_creation_key_unique
    ON documents (workspace_id, creation_key)
  `);
  await db.run(sql`
    CREATE TABLE collaboration_documents (
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      generation integer NOT NULL,
      is_current integer DEFAULT 1 NOT NULL,
      PRIMARY KEY (workspace_id, document_id, generation)
    )
  `);

  return db;
}

describe("document repository", () => {
  it("returns bounded stable summary pages without full document content", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);
    const created = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      repository.createDocumentFromContent(workspaceA, `Memo ${String(index)}`, {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `body-${String(index)}-${"x".repeat(600)}` }] }],
      })));
    const tiedAt = new Date("2026-01-02T00:00:00.000Z");
    await db.update(schema.documents).set({ updatedAt: tiedAt });

    const first = await repository.listDocumentSummaries(workspaceA, { limit: 2 });
    const second = await repository.listDocumentSummaries(workspaceA, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    const expectedIds = created.map(({ id }) => id).sort().reverse();
    expect(first.items.map(({ id }) => id)).toEqual(expectedIds.slice(0, 2));
    expect(second.items.map(({ id }) => id)).toEqual(expectedIds.slice(2));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).not.toHaveProperty("contentJson");
    expect(first.items.every(({ plainText }) => plainText.length <= 400)).toBe(true);

    await expect(repository.listDocumentSummaries(workspaceA, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
      query: "different-filter",
    })).rejects.toMatchObject({ name: "InvalidCollectionCursorError" });
    await expect(repository.listDocumentSummaries(workspaceB, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    })).rejects.toMatchObject({ name: "InvalidCollectionCursorError" });
  });

  it("rejects malformed document summary cursors", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);

    await expect(repository.listDocumentSummaries(workspaceA, { cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ name: "InvalidCollectionCursorError" });
  });

  it("applies exact typed Project Profile metadata filters in the database", async () => {
    const db = await createIsolatedDocumentDb();
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "typed-filter",
      labels: { en: { name: "Typed" }, ko: { name: "타입" } },
      metadataFields: [
        { filterable: true, id: "billable", labels: { en: "Billable", ko: "청구" }, type: "boolean" },
        { filterable: true, id: "owner", labels: { en: "Owner", ko: "소유자" }, type: "text" },
        { filterable: true, id: "score", labels: { en: "Score", ko: "점수" }, type: "number" },
        { filterable: true, id: "stage", labels: { en: "Stage", ko: "단계" }, options: ["open", "closed"], type: "select" },
        { filterable: true, id: "tags", labels: { en: "Tags", ko: "태그" }, type: "tags" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });
    const repository = createDocumentRepository(db, { projectProfile: profile });
    await repository.createDocumentFromDraft(workspaceA, {
      title: "Matching",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: { billable: false, owner: "123", score: 1.5, stage: "open", tags: ["risk", "msa"] },
    });
    await repository.createDocumentFromDraft(workspaceA, {
      title: "Other",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { billable: true, score: 2, stage: "closed", tags: ["brisk"] },
    });

    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "billable", metadataValue: "false" }))
      .resolves.toMatchObject({ items: [{ title: "Matching" }] });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "score", metadataValue: "1.5" }))
      .resolves.toMatchObject({ items: [{ title: "Matching" }] });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "stage", metadataValue: "open" }))
      .resolves.toMatchObject({ items: [{ title: "Matching" }] });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "tags", metadataValue: "risk" }))
      .resolves.toMatchObject({ items: [{ title: "Matching" }] });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "tags", metadataValue: "ris" }))
      .resolves.toMatchObject({ items: [] });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "score", metadataValue: "abc" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "billable", metadataValue: "nope" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "stage", metadataValue: "missing" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "unknown", metadataValue: "value" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataKey: "score" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
    await expect(repository.listDocumentSummaries(workspaceA, { metadataValue: "1.5" }))
      .rejects.toMatchObject({ name: "InvalidDocumentSummaryFilterError" });
  });

  it("treats malformed persisted metadata JSON as empty while evaluating filters", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);
    const valid = await repository.createDocumentFromDraft(workspaceA, {
      title: "Valid metadata",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { owner: "Legal" },
    });
    const corrupt = await repository.createDocumentFromDraft(workspaceA, {
      title: "Corrupt metadata",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { owner: "Legal" },
    });
    await db.run(sql`update documents set metadata_json = '{' where id = ${corrupt.id}`);

    await expect(repository.listDocumentSummaries(workspaceA, {
      metadataKey: "owner",
      metadataValue: "Legal",
    })).resolves.toMatchObject({ items: [{ id: valid.id, title: "Valid metadata" }] });
  });

  it("does not coerce malformed legacy JSON metadata into typed filter matches", async () => {
    const db = await createIsolatedDocumentDb();
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "legacy-filter-types",
      labels: { en: { name: "Legacy" }, ko: { name: "레거시" } },
      metadataFields: [
        { filterable: true, id: "billable", labels: { en: "Billable", ko: "청구" }, type: "boolean" },
        { filterable: true, id: "owner", labels: { en: "Owner", ko: "소유자" }, type: "text" },
        { filterable: true, id: "score", labels: { en: "Score", ko: "점수" }, type: "number" },
        { filterable: true, id: "stage", labels: { en: "Stage", ko: "단계" }, options: ["open"], type: "select" },
        { filterable: true, id: "tags", labels: { en: "Tags", ko: "태그" }, type: "tags" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });
    const repository = createDocumentRepository(db, { projectProfile: profile });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const baseDocument = {
      workspaceId: workspaceA.workspaceId,
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" as const }] },
      plainText: "",
      readiness: "draft" as const,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.documents).values([
      {
        ...baseDocument,
        id: "valid-types",
        title: "Valid types",
        metadataJson: { billable: false, owner: "123", score: 0, stage: "open", tags: ["risk"] },
      },
      {
        ...baseDocument,
        id: "legacy-types",
        title: "Legacy malformed types",
        metadataJson: {
          billable: "false",
          owner: 123,
          score: "not-a-number",
          stage: ["open"],
          tags: "risk",
        },
      },
    ]);

    for (const [metadataKey, metadataValue] of [
      ["billable", "false"],
      ["owner", "123"],
      ["score", "0"],
      ["stage", "open"],
      ["tags", "risk"],
    ] as const) {
      const page = await repository.listDocumentSummaries(workspaceA, { metadataKey, metadataValue });
      expect(page.items.map(({ id }) => id), `${metadataKey} must preserve its JSON type`).toEqual(["valid-types"]);
    }
  });

  it("creates a draft document with Tiptap JSON and plain text", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentDraft, listDocuments } = createDocumentRepository(db);

    const document = await createDocumentDraft(workspaceA, "Market Entry Memo");
    const documents = await listDocuments(workspaceA);

    expect(document.title).toBe("Market Entry Memo");
    expect(document.contentJson).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(document.plainText).toBe("");
    expect(document.readiness).toBe("draft");
    expect(document.metadataJson).toEqual({});
    expect(document.status).toBe("draft");
    expect(document.revision).toBe(0);
    expect(documents.some((item) => item.id === document.id)).toBe(true);
  });

  it("allows incomplete draft metadata while enforcing field constraints without changing readiness", async () => {
    const db = await createIsolatedDocumentDb();
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "required-draft",
      labels: { en: { name: "Required draft" }, ko: { name: "필수 초안" } },
      metadataFields: [
        { id: "owner", labels: { en: "Owner", ko: "소유자" }, maxLength: 10, required: true, type: "text" },
      ],
      readiness: [
        { id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: ["needs_review"] },
        { id: "needs_review", labels: { en: "Review", ko: "검토" }, transitions: ["draft"] },
      ],
    });
    const repository = createDocumentRepository(db, { projectProfile: profile });

    const document = await repository.createDocumentDraft(workspaceA, "Incomplete draft");
    const saved = await repository.saveDocumentDraft(workspaceA, document.id, {
      title: document.title,
      contentJson: document.contentJson,
      expectedRevision: 0,
      metadataJson: { owner: "Legal" },
    });

    expect(saved).toMatchObject({ status: "success", document: { metadataJson: { owner: "Legal" }, readiness: "draft" } });
    if (saved.status !== "success") throw new Error("Expected draft metadata save to succeed");
    const incompleteDraftSave = await repository.saveDocumentDraft(workspaceA, document.id, {
      title: document.title,
      contentJson: document.contentJson,
      expectedRevision: 1,
      metadataJson: {},
    });
    expect(incompleteDraftSave).toMatchObject({
      status: "success",
      document: { metadataJson: {}, readiness: "draft", revision: 2 },
    });
    await expect(repository.createDocumentFromDraft(workspaceA, {
      title: "Oversized",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { owner: "x".repeat(11) },
    })).rejects.toMatchObject({
      name: "ProjectProfileViolationError",
      violation: { fieldId: "owner", ok: false, reason: "invalid_length" },
    });
  });

  it("creates a document from converted Tiptap content and derives plain text", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromContent } = createDocumentRepository(db);

    const document = await createDocumentFromContent(workspaceA, "Imported Contract", {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Contract" }] },
        { type: "paragraph", content: [{ type: "text", text: "Imported body" }] },
      ],
    });

    expect(document.title).toBe("Imported Contract");
    expect(document.contentJson).toMatchObject({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Contract" }] },
        { type: "paragraph", content: [{ type: "text", text: "Imported body" }] },
      ],
    });
    expect(document.plainText).toBe("Contract\nImported body");
    expect(document.status).toBe("draft");
    expect(document.revision).toBe(0);
  });

  it("creates a complete draft atomically with metadata and server-owned initial readiness", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraft } = createDocumentRepository(db);

    const document = await createDocumentFromDraft(workspaceA, {
      title: "Recovered local draft",
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved local work" }] }],
      },
      metadataJson: { owner: "Legal", tags: ["recovered"] },
    });

    expect(document).toMatchObject({
      title: "Recovered local draft",
      plainText: "Unsaved local work",
      metadataJson: { owner: "Legal", tags: ["recovered"] },
      readiness: "draft",
      revision: 0,
      status: "draft",
    });
  });

  it("forces direct full-draft creation to the Project Profile initial readiness", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraft } = createDocumentRepository(db);

    const untrustedDraft = {
      title: "Untrusted recovery payload",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
      readiness: "approved" as const,
    };
    const document = await createDocumentFromDraft(workspaceA, untrustedDraft);

    expect(document.readiness).toBe("draft");
  });

  it("replays an idempotent recovery create without mutating its original payload", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraftIdempotently } = createDocumentRepository(db);
    const firstDraft = {
      title: "Original recovery copy",
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Original local work" }] }],
      },
      metadataJson: { owner: "Legal" },
    };

    const created = await createDocumentFromDraftIdempotently(workspaceA, firstDraft, "recovery-key-123456");
    const replayed = await createDocumentFromDraftIdempotently(workspaceA, {
      ...firstDraft,
      title: "Must not overwrite",
    }, "recovery-key-123456");

    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({
      document: {
        id: created.document.id,
        title: "Original recovery copy",
        creationKey: "recovery-key-123456",
      },
      replayed: true,
    });
  });

  it("scopes recovery creation keys by workspace", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraftIdempotently } = createDocumentRepository(db);
    const draft = {
      title: "Recovery copy",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
    };

    const workspaceACopy = await createDocumentFromDraftIdempotently(
      workspaceA,
      draft,
      "shared-recovery-key",
    );
    const workspaceBCopy = await createDocumentFromDraftIdempotently(
      workspaceB,
      draft,
      "shared-recovery-key",
    );

    expect(workspaceACopy.document.id).not.toBe(workspaceBCopy.document.id);
    expect(workspaceACopy.replayed).toBe(false);
    expect(workspaceBCopy.replayed).toBe(false);
  });

  it("creates exactly one document for concurrent requests with the same recovery key", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraftIdempotently, listDocuments } = createDocumentRepository(db);
    const draft = {
      title: "Concurrent recovery copy",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
    };

    const results = await Promise.all([
      createDocumentFromDraftIdempotently(workspaceA, draft, "concurrent-recovery-key"),
      createDocumentFromDraftIdempotently(workspaceA, draft, "concurrent-recovery-key"),
    ]);

    expect(new Set(results.map((result) => result.document.id)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await listDocuments(workspaceA)).toHaveLength(1);
  });

  it("releases an archived recovery copy key so a retry creates a new active copy", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentFromDraftIdempotently } = createDocumentRepository(db);
    const draft = {
      title: "Recovery copy",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
    };

    const first = await createDocumentFromDraftIdempotently(
      workspaceA,
      draft,
      "archived-recovery-key",
    );
    await archiveDocument(workspaceA, first.document.id);
    const retried = await createDocumentFromDraftIdempotently(
      workspaceA,
      draft,
      "archived-recovery-key",
    );

    expect(retried.replayed).toBe(false);
    expect(retried.document.id).not.toBe(first.document.id);
    expect(retried.document.status).toBe("draft");
  });

  it("archives an existing document and removes it from draft listings", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft, getDocumentById, listDocuments } = createDocumentRepository(db);
    const document = await createDocumentDraft(workspaceA, "Market Entry Memo");

    const archivedDocument = await archiveDocument(workspaceA, document.id);
    const savedDocument = await getDocumentById(workspaceA, document.id);
    const documents = await listDocuments(workspaceA);

    expect(archivedDocument?.id).toBe(document.id);
    expect(archivedDocument?.status).toBe("archived");
    expect(savedDocument).toBeNull();
    expect(documents.some((item) => item.id === document.id)).toBe(false);
  });

  it("returns null when archiving a missing or already archived document", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft } = createDocumentRepository(db);
    const document = await createDocumentDraft(workspaceA, "Market Entry Memo");
    await archiveDocument(workspaceA, document.id);

    await expect(archiveDocument(workspaceA, "missing-document")).resolves.toBeNull();
    await expect(archiveDocument(workspaceA, document.id)).resolves.toBeNull();
  });

  it("returns not_found when saving an archived document", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft, saveDocumentDraft } = createDocumentRepository(db);
    const document = await createDocumentDraft(workspaceA, "Market Entry Memo");
    await archiveDocument(workspaceA, document.id);

    await expect(
      saveDocumentDraft(workspaceA, document.id, {
        title: "Updated Memo",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Updated" }] }] },
        expectedRevision: 0,
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("atomically saves the expected revision and rejects a stale save without overwriting", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentDraft, saveDocumentDraft } = createDocumentRepository(db);
    const document = await createDocumentDraft(workspaceA, "Market Entry Memo");

    const saved = await saveDocumentDraft(workspaceA, document.id, {
      title: "Updated Memo",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Updated" }] }] },
      metadataJson: { owner: "Legal", tags: ["risk"] },
      expectedRevision: 0,
    });

    expect(saved).toMatchObject({
      status: "success",
      document: {
        metadataJson: { owner: "Legal", tags: ["risk"] },
        plainText: "Updated",
        readiness: "draft",
        revision: 1,
      },
    });

    const stale = await saveDocumentDraft(workspaceA, document.id, {
      title: "Stale overwrite",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Stale" }] }] },
      expectedRevision: 0,
    });

    expect(stale).toMatchObject({
      status: "revision_conflict",
      latest: { title: "Updated Memo", plainText: "Updated", revision: 1 },
    });
  });

  it("preserves server readiness when a direct legacy save attempts to smuggle approval", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);
    const document = await repository.createDocumentDraft(workspaceA, "Server workflow");

    const untrustedSave = {
      title: "Body-only update",
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Body-only update" }] }],
      },
      expectedRevision: 0,
      readiness: "approved" as const,
    };
    const saved = await repository.saveDocumentDraft(workspaceA, document.id, untrustedSave);

    expect(saved).toMatchObject({
      status: "success",
      document: { readiness: "draft", revision: 1 },
    });
  });

  it("fences legacy full-draft writes after collaboration has initialized", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);
    const document = await repository.createDocumentDraft(workspaceA, "Canonical collaboration draft");
    await db.run(sql`
      INSERT INTO collaboration_documents (workspace_id, document_id, generation, is_current)
      VALUES (${workspaceA.workspaceId}, ${document.id}, 1, 0)
    `);

    const result = await repository.saveDocumentDraft(workspaceA, document.id, {
      contentJson: {
        content: [{ content: [{ text: "Legacy overwrite", type: "text" }], type: "paragraph" }],
        type: "doc",
      },
      expectedRevision: 0,
      metadataJson: { owner: "Legacy writer" },
      title: "Legacy overwrite",
    });

    expect(result).toEqual({ status: "collaboration_initialized" });
    await expect(repository.getDocumentById(workspaceA, document.id)).resolves.toMatchObject({
      contentJson: document.contentJson,
      metadataJson: document.metadataJson,
      readiness: document.readiness,
      revision: 0,
      title: "Canonical collaboration draft",
    });
  });

  it("enforces Project Profile metadata on direct repository creation", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentFromDraft } = createDocumentRepository(db, {
      projectProfile: getProjectProfile("legal-review"),
    });

    await expect(createDocumentFromDraft(workspaceA, {
      title: "Contract",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { researchQuestion: "Out of profile" },
    })).rejects.toMatchObject({
      name: "ProjectProfileViolationError",
      violation: { fieldId: "researchQuestion", reason: "unknown_field" },
    });
  });

  it("preserves unknown legacy metadata and server readiness across direct saves", async () => {
    const db = await createIsolatedDocumentDb();
    const defaultRepository = createDocumentRepository(db);
    const document = await defaultRepository.createDocumentDraft(workspaceA, "Legacy contract");
    await db.run(sql`
      UPDATE documents
      SET metadata_json = '{"legacyWorkflow":"keep-me"}', readiness = 'needs_review'
      WHERE id = ${document.id}
    `);
    const legalRepository = createDocumentRepository(db, {
      projectProfile: getProjectProfile("legal-review"),
    });

    const saved = await legalRepository.saveDocumentDraft(workspaceA, document.id, {
      title: "Reviewed contract",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: { counterparty: "Core Dot" },
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      status: "success",
      document: {
        metadataJson: { counterparty: "Core Dot", legacyWorkflow: "keep-me" },
        readiness: "needs_review",
        revision: 1,
      },
    });

    const untrustedSave = {
      title: "Illegally approved contract",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      readiness: "approved" as const,
      expectedRevision: 1,
    };
    const secondSave = await legalRepository.saveDocumentDraft(workspaceA, document.id, untrustedSave);
    expect(secondSave).toMatchObject({
      status: "success",
      document: { readiness: "needs_review", revision: 2 },
    });
    await expect(legalRepository.getDocumentById(workspaceA, document.id)).resolves.toMatchObject({
      readiness: "needs_review",
      revision: 2,
      title: "Illegally approved contract",
    });
  });

  it("allows exactly one of two parallel saves from the same revision", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentDraft, saveDocumentDraft } = createDocumentRepository(db);
    const document = await createDocumentDraft(workspaceA, "Parallel Memo");

    const results = await Promise.all([
      saveDocumentDraft(workspaceA, document.id, {
        title: "Writer A",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
        expectedRevision: 0,
      }),
      saveDocumentDraft(workspaceA, document.id, {
        title: "Writer B",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
        expectedRevision: 0,
      }),
    ]);

    expect(results.filter((result) => result.status === "success")).toHaveLength(1);
    const conflict = results.find((result) => result.status === "revision_conflict");
    expect(conflict).toMatchObject({ status: "revision_conflict", latest: { revision: 1 } });
  });

  it("lists reference candidates while excluding the current and archived documents", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentFromContent, listDocumentReferenceCandidates } = createDocumentRepository(db);
    const current = await createDocumentFromContent(workspaceA, "Current Plan", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Current body" }] }],
    });
    const referenced = await createDocumentFromContent(workspaceA, "Revenue Memo", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Reference body" }] }],
    });
    const archived = await createDocumentFromContent(workspaceA, "Revenue Archive", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Archived body" }] }],
    });
    await archiveDocument(workspaceA, archived.id);

    const candidates = await listDocumentReferenceCandidates(workspaceA, {
      excludeDocumentId: current.id,
      limit: 5,
      query: "revenue",
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([referenced.id]);
    expect(candidates[0]).toMatchObject({ plainText: "Reference body", title: "Revenue Memo" });
  });

  it("returns referenced documents in stable input order", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentDraft, getDocumentsByIds } = createDocumentRepository(db);
    const first = await createDocumentDraft(workspaceA, "First");
    const second = await createDocumentDraft(workspaceA, "Second");

    const documents = await getDocumentsByIds(workspaceA, [second.id, "missing", first.id]);

    expect(documents.map((document) => document.id)).toEqual([second.id, first.id]);
  });

  it("does not reveal or mutate documents across workspaces", async () => {
    const db = await createIsolatedDocumentDb();
    const repository = createDocumentRepository(db);
    const document = await repository.createDocumentDraft(workspaceA, "Workspace A memo");

    await expect(repository.getDocumentById(workspaceB, document.id)).resolves.toBeNull();
    await expect(repository.getDocumentsByIds(workspaceB, [document.id])).resolves.toEqual([]);
    await expect(repository.listDocuments(workspaceB)).resolves.toEqual([]);
    await expect(
      repository.saveDocumentDraft(workspaceB, document.id, {
        title: "Hijacked",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        expectedRevision: 0,
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(repository.archiveDocument(workspaceB, document.id)).resolves.toBeNull();

    await expect(repository.getDocumentById(workspaceA, document.id)).resolves.toMatchObject({
      status: "draft",
      title: "Workspace A memo",
      workspaceId: workspaceA.workspaceId,
    });
  });
});
