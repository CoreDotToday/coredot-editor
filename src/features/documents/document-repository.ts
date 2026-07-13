import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { documents, type DocumentMetadata, type DocumentReadiness, type TiptapJson } from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { normalizeDocumentMetadata, normalizeDocumentReadiness } from "./document-metadata";
import { extractPlainTextFromTiptap } from "./tiptap-text";

type DocumentDatabase = typeof db;

export const emptyDocument: TiptapJson = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function createDocumentRepository(database: DocumentDatabase = db) {
  return {
    async createDocumentDraft(scope: WorkspaceScope, title: string) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title,
          contentJson: emptyDocument,
          metadataJson: {},
          plainText: "",
          readiness: "draft",
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async createDocumentFromContent(scope: WorkspaceScope, title: string, contentJson: TiptapJson) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title,
          contentJson,
          metadataJson: {},
          plainText: extractPlainTextFromTiptap(contentJson),
          readiness: "draft",
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async listDocuments(scope: WorkspaceScope) {
      return database
        .select()
        .from(documents)
        .where(and(eq(documents.workspaceId, scope.workspaceId), eq(documents.status, "draft")))
        .orderBy(desc(documents.updatedAt));
    },

    async getDocumentById(scope: WorkspaceScope, id: string) {
      const rows = await database
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getDocumentsByIds(scope: WorkspaceScope, ids: string[]) {
      if (ids.length === 0) {
        return [];
      }

      const uniqueIds = Array.from(new Set(ids));
      const rows = await database
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, scope.workspaceId),
            inArray(documents.id, uniqueIds),
            eq(documents.status, "draft"),
          ),
        );
      const byId = new Map(rows.map((document) => [document.id, document]));

      return uniqueIds.flatMap((id) => {
        const document = byId.get(id);
        return document ? [document] : [];
      });
    },

    async listDocumentReferenceCandidates(
      scope: WorkspaceScope,
      input: { excludeDocumentId?: string; limit?: number; query?: string } = {},
    ) {
      const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
      const normalizedQuery = input.query?.trim().toLocaleLowerCase() ?? "";
      const rows = await database
        .select()
        .from(documents)
        .where(and(eq(documents.workspaceId, scope.workspaceId), eq(documents.status, "draft")))
        .orderBy(desc(documents.updatedAt));

      return rows
        .filter((document) => document.id !== input.excludeDocumentId)
        .filter((document) => {
          if (!normalizedQuery) {
            return true;
          }

          return (
            document.title.toLocaleLowerCase().includes(normalizedQuery) ||
            document.plainText.toLocaleLowerCase().includes(normalizedQuery)
          );
        })
        .slice(0, limit);
    },

    async saveDocumentDraft(
      scope: WorkspaceScope,
      id: string,
      input: {
        title: string;
        contentJson: TiptapJson;
        metadataJson?: DocumentMetadata;
        readiness?: DocumentReadiness;
        expectedRevision: number;
      },
    ) {
      const now = new Date();
      const rows = await database
        .update(documents)
        .set({
          title: input.title,
          contentJson: input.contentJson,
          metadataJson: input.metadataJson === undefined ? undefined : normalizeDocumentMetadata(input.metadataJson),
          plainText: extractPlainTextFromTiptap(input.contentJson),
          readiness: input.readiness === undefined ? undefined : normalizeDocumentReadiness(input.readiness),
          revision: input.expectedRevision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
            eq(documents.revision, input.expectedRevision),
          ),
        )
        .returning();

      const savedDocument = rows[0];
      if (savedDocument) {
        return { document: savedDocument, status: "success" as const };
      }

      const [latest] = await database
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
          ),
        )
        .limit(1);

      return latest
        ? { latest, status: "revision_conflict" as const }
        : { status: "not_found" as const };
    },

    async archiveDocument(scope: WorkspaceScope, id: string) {
      const now = new Date();
      const rows = await database
        .update(documents)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
          ),
        )
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
export const getDocumentsByIds = defaultRepository.getDocumentsByIds;
export const listDocumentReferenceCandidates = defaultRepository.listDocumentReferenceCandidates;
export const saveDocumentDraft = defaultRepository.saveDocumentDraft;
export const archiveDocument = defaultRepository.archiveDocument;
