import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import { documents, type DocumentMetadata, type DocumentReadiness, type TiptapJson } from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { decodeCollectionCursor, encodeCollectionCursor } from "@/features/pagination/collection-cursor";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import {
  ProjectProfileViolationError,
  validateProjectDocumentState,
  type ProjectProfile,
} from "@/features/projects/project-profile";
import { createDocumentFilterDefinitions } from "@/features/projects/project-profile";
import { parseDocumentSummaryFilters, type DocumentSummaryFilters } from "./document-filters";
import { normalizeDocumentMetadata, normalizeDocumentReadiness } from "./document-metadata";
import { extractPlainTextFromTiptap } from "./tiptap-text";

type DocumentDatabase = typeof db;

export const emptyDocument: TiptapJson = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const DOCUMENT_SUMMARY_PREVIEW_CODE_UNITS = 400;

export function createDocumentRepository(
  database: DocumentDatabase = db,
  options: { projectProfile?: ProjectProfile } = {},
) {
  const projectProfile = options.projectProfile ?? getProjectProfile("default");

  return {
    async createDocumentDraft(scope: WorkspaceScope, title: string) {
      const state = validateNewDocumentState(projectProfile, { metadataJson: {}, readiness: "draft" });
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title,
          contentJson: emptyDocument,
          metadataJson: state.metadataJson,
          plainText: "",
          readiness: state.readiness,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return rows[0]!;
    },

    async createDocumentFromContent(scope: WorkspaceScope, title: string, contentJson: TiptapJson) {
      const state = validateNewDocumentState(projectProfile, { metadataJson: {}, readiness: "draft" });
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title,
          contentJson,
          metadataJson: state.metadataJson,
          plainText: extractPlainTextFromTiptap(contentJson),
          readiness: state.readiness,
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
      const state = validateNewDocumentState(projectProfile, input);
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          title: input.title,
          contentJson: input.contentJson,
          metadataJson: normalizeDocumentMetadata(state.metadataJson),
          plainText: extractPlainTextFromTiptap(input.contentJson),
          readiness: normalizeDocumentReadiness(state.readiness),
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
      const state = validateNewDocumentState(projectProfile, input);
      const now = new Date();
      const rows = await database
        .insert(documents)
        .values({
          workspaceId: scope.workspaceId,
          creationKey,
          title: input.title,
          contentJson: input.contentJson,
          metadataJson: normalizeDocumentMetadata(state.metadataJson),
          plainText: extractPlainTextFromTiptap(input.contentJson),
          readiness: normalizeDocumentReadiness(state.readiness),
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

    async listDocumentSummaries(
      scope: WorkspaceScope,
      input: DocumentSummaryFilters & { cursor?: string; limit?: number } = {},
    ) {
      const filters = parseDocumentSummaryFilters(projectProfile, {
        metadataKey: input.metadataKey,
        metadataValue: input.metadataValue,
        query: input.query,
        readiness: input.readiness,
      });
      const limit = normalizePageLimit(input.limit);
      const cursorScope = {
        collection: "documents",
        documentStatus: "draft",
        metadataKey: filters.metadataKey ?? null,
        metadataValue: filters.metadataValue ?? null,
        projectProfileId: projectProfile.id,
        query: filters.query?.trim().toLocaleLowerCase() ?? null,
        readiness: filters.readiness ?? null,
        workspaceId: scope.workspaceId,
      } as const;
      const cursor = input.cursor ? decodeCollectionCursor(input.cursor, cursorScope) : null;
      const cursorCondition = cursor
        ? or(
            lt(documents.updatedAt, cursor.timestamp),
            and(eq(documents.updatedAt, cursor.timestamp), lt(documents.id, cursor.id)),
          )
        : undefined;
      const readinessCondition = filters.readiness && filters.readiness !== "all"
        ? eq(documents.readiness, filters.readiness)
        : undefined;
      const query = filters.query?.trim().toLocaleLowerCase();
      const escapedQuery = query ? `%${escapeLike(query)}%` : null;
      const queryCondition = escapedQuery
        ? or(
            sql`lower(${documents.title}) like ${escapedQuery} escape ${"\\"}`,
            sql`lower(${documents.plainText}) like ${escapedQuery} escape ${"\\"}`,
          )
        : undefined;
      const metadataDefinitions = new Map(createDocumentFilterDefinitions(projectProfile).map((definition) => [definition.id, definition]));
      const metadataKey = filters.metadataKey;
      const metadataValue = filters.metadataValue;
      const metadataDefinition = metadataKey ? metadataDefinitions.get(metadataKey) : undefined;
      const metadataCondition = metadataDefinition && metadataValue
        ? createMetadataCondition(metadataDefinition, metadataValue)
        : undefined;
      const rows = await database
        .select({
          id: documents.id,
          metadataJson: documents.metadataJson,
          plainText: sql<string>`substr(${documents.plainText}, 1, ${DOCUMENT_SUMMARY_PREVIEW_CODE_UNITS})`,
          readiness: documents.readiness,
          revision: documents.revision,
          title: documents.title,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(and(
          eq(documents.workspaceId, scope.workspaceId),
          eq(documents.status, "draft"),
          cursorCondition,
          readinessCondition,
          queryCondition,
          metadataCondition,
        ))
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit && items.length > 0
          ? encodeCollectionCursor({ id: items.at(-1)!.id, timestamp: items.at(-1)!.updatedAt }, cursorScope)
          : null,
      };
    },

    async listDocuments(scope: WorkspaceScope) {
      return database
        .select()
        .from(documents)
        .where(and(eq(documents.workspaceId, scope.workspaceId), eq(documents.status, "draft")))
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(50);
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
        .where(and(
          eq(documents.workspaceId, scope.workspaceId),
          eq(documents.status, "draft"),
          input.excludeDocumentId ? ne(documents.id, input.excludeDocumentId) : undefined,
          normalizedQuery
            ? or(
                sql`lower(${documents.title}) like ${`%${escapeLike(normalizedQuery)}%`} escape ${"\\"}`,
                sql`lower(${documents.plainText}) like ${`%${escapeLike(normalizedQuery)}%`} escape ${"\\"}`,
              )
            : undefined,
        ))
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(limit);

      return rows;
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
      return withSerializedDocumentWrite(scope, id, async () => {
        const [current] = await database
          .select()
          .from(documents)
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
          ))
          .limit(1);
        if (!current) return { status: "not_found" as const };
        if (current.revision !== input.expectedRevision) {
          return { latest: current, status: "revision_conflict" as const };
        }

        const stateResult = validateProjectDocumentState(projectProfile, {
          metadataJson: input.metadataJson ?? current.metadataJson,
          readiness: input.readiness ?? current.readiness,
        }, {
          metadataJson: current.metadataJson,
          readiness: current.readiness,
        });
        if (!stateResult.ok) {
          return { status: "invalid_profile" as const, violation: stateResult.violation };
        }

        const rows = await retrySqliteContention(async () => database
          .update(documents)
          .set({
            title: input.title,
            contentJson: input.contentJson,
            metadataJson: normalizeDocumentMetadata(stateResult.value.metadataJson),
            plainText: extractPlainTextFromTiptap(input.contentJson),
            readiness: normalizeDocumentReadiness(stateResult.value.readiness),
            revision: input.expectedRevision + 1,
            updatedAt: now,
          })
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
            eq(documents.revision, input.expectedRevision),
          ))
          .returning());
        const savedDocument = rows[0];
        if (savedDocument) return { document: savedDocument, status: "success" as const };

        const [latest] = await database
          .select()
          .from(documents)
          .where(and(
            eq(documents.workspaceId, scope.workspaceId),
            eq(documents.id, id),
            eq(documents.status, "draft"),
          ))
          .limit(1);
        return latest
          ? { latest, status: "revision_conflict" as const }
          : { status: "not_found" as const };
      });
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

function validateNewDocumentState(
  projectProfile: ProjectProfile,
  input: { metadataJson: DocumentMetadata; readiness: DocumentReadiness },
) {
  const result = validateProjectDocumentState(projectProfile, input);
  if (!result.ok) throw new ProjectProfileViolationError(result.violation);
  return result.value;
}

function normalizePageLimit(value: number | undefined) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(value ?? 20, 50)) : 20;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function createMetadataCondition(
  definition: ReturnType<typeof createDocumentFilterDefinitions>[number],
  value: string,
) {
  const path = `$."${definition.id}"`;
  const safeMetadataJson = sql`case
    when json_valid(${documents.metadataJson}) then ${documents.metadataJson}
    else '{}'
  end`;
  if (definition.type === "boolean") {
    if (value !== "true" && value !== "false") return sql`0`;
    return sql`json_type(${safeMetadataJson}, ${path}) in ('true', 'false')
      and json_extract(${safeMetadataJson}, ${path}) = ${value === "true" ? 1 : 0}`;
  }
  if (definition.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) return sql`0`;
    return sql`json_type(${safeMetadataJson}, ${path}) in ('integer', 'real')
      and json_extract(${safeMetadataJson}, ${path}) = ${number}`;
  }
  if (definition.type === "select") {
    if (!definition.options?.includes(value)) return sql`0`;
    return sql`json_type(${safeMetadataJson}, ${path}) = 'text'
      and json_extract(${safeMetadataJson}, ${path}) = ${value}`;
  }
  if (definition.type === "date") {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
      return sql`0`;
    }
    return sql`json_type(${safeMetadataJson}, ${path}) = 'text'
      and json_extract(${safeMetadataJson}, ${path}) = ${value}`;
  }
  if (definition.type === "tags") {
    return sql`json_type(${safeMetadataJson}, ${path}) = 'array'
      and exists (
        select 1 from json_each(${safeMetadataJson}, ${path})
        where type = 'text' and lower(value) = ${value.toLocaleLowerCase()}
      )`;
  }
  return sql`json_type(${safeMetadataJson}, ${path}) = 'text'
    and lower(json_extract(${safeMetadataJson}, ${path})) like ${`%${escapeLike(value.toLocaleLowerCase())}%`} escape ${"\\"}`;
}

const defaultRepository = createDocumentRepository(db, { projectProfile: resolveActiveProjectProfile() });

export const createDocumentDraft = defaultRepository.createDocumentDraft;
export const createDocumentFromContent = defaultRepository.createDocumentFromContent;
export const createDocumentFromDraft = defaultRepository.createDocumentFromDraft;
export const createDocumentFromDraftIdempotently = defaultRepository.createDocumentFromDraftIdempotently;
export const listDocumentSummaries = defaultRepository.listDocumentSummaries;
export const listDocuments = defaultRepository.listDocuments;
export const getDocumentById = defaultRepository.getDocumentById;
export const getDocumentsByIds = defaultRepository.getDocumentsByIds;
export const listDocumentReferenceCandidates = defaultRepository.listDocumentReferenceCandidates;
export const saveDocumentDraft = defaultRepository.saveDocumentDraft;
export const archiveDocument = defaultRepository.archiveDocument;
