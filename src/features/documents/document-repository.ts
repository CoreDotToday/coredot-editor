import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import { documents, type DocumentMetadata, type DocumentReadiness, type TiptapJson } from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";
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

    async createDocumentFromDraft(
      scope: WorkspaceScope,
      input: {
        title: string;
        contentJson: TiptapJson;
        metadataJson: DocumentMetadata;
        readiness: DocumentReadiness;
      },
    ) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title: input.title,
          contentJson: input.contentJson,
          metadataJson: normalizeDocumentMetadata(input.metadataJson),
          plainText: extractPlainTextFromTiptap(input.contentJson),
          readiness: normalizeDocumentReadiness(input.readiness),
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async createDocumentFromDraftIdempotently(
      scope: WorkspaceScope,
      input: {
        title: string;
        contentJson: TiptapJson;
        metadataJson: DocumentMetadata;
        readiness: DocumentReadiness;
      },
      creationKey: string,
    ) {
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          creationKey,
          title: input.title,
          contentJson: input.contentJson,
          metadataJson: normalizeDocumentMetadata(input.metadataJson),
          plainText: extractPlainTextFromTiptap(input.contentJson),
          readiness: normalizeDocumentReadiness(input.readiness),
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [documents.workspaceId, documents.creationKey] })
        .returning();

      if (rows[0]) {
        return { document: rows[0], replayed: false as const };
      }

      const existingRows = await database
        .select()
        .from(documents)
        .where(and(
          eq(documents.workspaceId, scope.workspaceId),
          eq(documents.creationKey, creationKey),
        ))
        .limit(1);
      const existingDocument = existingRows[0];
      if (!existingDocument) {
        throw new Error("Idempotent document creation did not produce a document");
      }
      return { document: existingDocument, replayed: true as const };
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
        .select({
          id: documents.id,
          plainText: documents.plainText,
          title: documents.title,
          updatedAt: documents.updatedAt,
        })
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
      const rows = await withSerializedDocumentWrite(scope, id, () => retrySqliteContention(async () => database
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
        .returning()));

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
        .set({ creationKey: null, status: "archived", updatedAt: now })
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
export const createDocumentFromDraft = defaultRepository.createDocumentFromDraft;
export const createDocumentFromDraftIdempotently = defaultRepository.createDocumentFromDraftIdempotently;
export const listDocuments = defaultRepository.listDocuments;
export const getDocumentById = defaultRepository.getDocumentById;
export const getDocumentsByIds = defaultRepository.getDocumentsByIds;
export const listDocumentReferenceCandidates = defaultRepository.listDocumentReferenceCandidates;
export const saveDocumentDraft = defaultRepository.saveDocumentDraft;
export const archiveDocument = defaultRepository.archiveDocument;
