import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createDocumentRepository } from "./document-repository";

const tempDirs: string[] = [];

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
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      CONSTRAINT "documents_status_check" CHECK(status in ('draft', 'archived'))
    )
  `);

  return db;
}

describe("document repository", () => {
  it("creates a draft document with Tiptap JSON and plain text", async () => {
    const db = await createIsolatedDocumentDb();
    const { createDocumentDraft, listDocuments } = createDocumentRepository(db);

    const document = await createDocumentDraft("Market Entry Memo");
    const documents = await listDocuments();

    expect(document.title).toBe("Market Entry Memo");
    expect(document.contentJson).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(document.plainText).toBe("");
    expect(document.status).toBe("draft");
    expect(documents.some((item) => item.id === document.id)).toBe(true);
  });

  it("archives an existing document and removes it from draft listings", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft, getDocumentById, listDocuments } = createDocumentRepository(db);
    const document = await createDocumentDraft("Market Entry Memo");

    const archivedDocument = await archiveDocument(document.id);
    const savedDocument = await getDocumentById(document.id);
    const documents = await listDocuments();

    expect(archivedDocument?.id).toBe(document.id);
    expect(archivedDocument?.status).toBe("archived");
    expect(savedDocument).toBeNull();
    expect(documents.some((item) => item.id === document.id)).toBe(false);
  });

  it("returns null when archiving a missing or already archived document", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft } = createDocumentRepository(db);
    const document = await createDocumentDraft("Market Entry Memo");
    await archiveDocument(document.id);

    await expect(archiveDocument("missing-document")).resolves.toBeNull();
    await expect(archiveDocument(document.id)).resolves.toBeNull();
  });

  it("returns null when updating an archived document", async () => {
    const db = await createIsolatedDocumentDb();
    const { archiveDocument, createDocumentDraft, updateDocumentContent } = createDocumentRepository(db);
    const document = await createDocumentDraft("Market Entry Memo");
    await archiveDocument(document.id);

    await expect(
      updateDocumentContent(document.id, {
        title: "Updated Memo",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Updated" }] }] },
      }),
    ).resolves.toBeNull();
  });
});
