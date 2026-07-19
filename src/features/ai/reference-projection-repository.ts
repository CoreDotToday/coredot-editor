import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { collaborationDocuments, documents } from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import type { CollaborationDatabase } from "@/features/collaboration/repository";

export type AiReferenceProjection = {
  generation: number | null;
  headSeq: number | null;
  id: string;
  plainText: string;
  projectedSeq: number | null;
  title: string;
};

export function createAiReferenceProjectionRepository(database: Pick<CollaborationDatabase, "select">) {
  return async function getAiReferenceProjectionsByIds(
    scope: WorkspaceScope,
    ids: string[],
  ): Promise<AiReferenceProjection[]> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) return [];

    const rows = await database
      .select({
        generation: collaborationDocuments.generation,
        headSeq: collaborationDocuments.headSeq,
        id: documents.id,
        plainText: documents.plainText,
        projectedSeq: collaborationDocuments.projectedSeq,
        title: documents.title,
      })
      .from(documents)
      .leftJoin(collaborationDocuments, and(
        eq(collaborationDocuments.workspaceId, documents.workspaceId),
        eq(collaborationDocuments.documentId, documents.id),
        eq(collaborationDocuments.isCurrent, true),
      ))
      .where(and(
        eq(documents.workspaceId, scope.workspaceId),
        inArray(documents.id, uniqueIds),
        eq(documents.status, "draft"),
      ))
      .limit(uniqueIds.length);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return uniqueIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  };
}

export const getAiReferenceProjectionsByIds = createAiReferenceProjectionRepository(db);
