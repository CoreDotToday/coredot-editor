import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { documents, type TiptapJson } from "@/db/schema";
import { extractPlainTextFromTiptap } from "./tiptap-text";

type DocumentDatabase = typeof db;

export const emptyDocument: TiptapJson = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function createDocumentRepository(database: DocumentDatabase = db) {
  return {
    async createDocumentDraft(title: string) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          title,
          contentJson: emptyDocument,
          plainText: "",
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async createDocumentFromContent(title: string, contentJson: TiptapJson) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          title,
          contentJson,
          plainText: extractPlainTextFromTiptap(contentJson),
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async listDocuments() {
      return database.select().from(documents).where(eq(documents.status, "draft")).orderBy(desc(documents.updatedAt));
    },

    async getDocumentById(id: string) {
      const rows = await database
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.status, "draft")))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateDocumentContent(id: string, input: { title: string; contentJson: TiptapJson }) {
      const now = new Date();
      const rows = await database
        .update(documents)
        .set({
          title: input.title,
          contentJson: input.contentJson,
          plainText: extractPlainTextFromTiptap(input.contentJson),
          updatedAt: now,
        })
        .where(and(eq(documents.id, id), eq(documents.status, "draft")))
        .returning();

      return rows[0] ?? null;
    },

    async archiveDocument(id: string) {
      const now = new Date();
      const rows = await database
        .update(documents)
        .set({ status: "archived", updatedAt: now })
        .where(and(eq(documents.id, id), eq(documents.status, "draft")))
        .returning();

      return rows[0] ?? null;
    },
  };
}

const defaultRepository = createDocumentRepository();

export const createDocumentDraft = defaultRepository.createDocumentDraft;
export const createDocumentFromContent = defaultRepository.createDocumentFromContent;
export const listDocuments = defaultRepository.listDocuments;
export const getDocumentById = defaultRepository.getDocumentById;
export const updateDocumentContent = defaultRepository.updateDocumentContent;
export const archiveDocument = defaultRepository.archiveDocument;
