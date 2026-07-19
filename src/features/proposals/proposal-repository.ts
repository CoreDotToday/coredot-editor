import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiProposals,
  collaborationDocuments,
  collaborationProposalAnchors,
  type NewAiProposalRecord,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { decodeCollectionCursor, encodeCollectionCursor } from "@/features/pagination/collection-cursor";
import { ProposalStatusUpdateConflictError } from "./proposal-status-errors";

type ProposalDatabase = typeof db;

type CreateProposalInput = Pick<
  NewAiProposalRecord,
  "aiRunId" | "documentId" | "targetText" | "replacementText" | "explanation"
> &
  Partial<
    Pick<
      NewAiProposalRecord,
      "source" | "command" | "occurrenceIndex" | "targetFrom" | "targetTo" | "defaultApplyMode"
    >
  >;

export function createProposalRepository(database: ProposalDatabase = db) {
  return {
    async createProposal(scope: WorkspaceScope, input: CreateProposalInput) {
      const now = new Date();
      const [proposal] = await database
        .insert(aiProposals)
        .values({
          ...input,
          workspaceId: scope.workspaceId,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return proposal!;
    },

    async listProposalsForDocument(scope: WorkspaceScope, documentId: string) {
      return database
        .select()
        .from(aiProposals)
        .where(and(eq(aiProposals.workspaceId, scope.workspaceId), eq(aiProposals.documentId, documentId)))
        .orderBy(desc(aiProposals.createdAt), desc(aiProposals.id))
        .limit(50);
    },

    async listProposalSummariesPage(
      scope: WorkspaceScope,
      documentId: string,
      input: { cursor?: string; limit?: number } = {},
    ) {
      const limit = normalizePageLimit(input.limit);
      const cursorScope = {
        collection: "proposals",
        documentId,
        workspaceId: scope.workspaceId,
      } as const;
      const cursor = input.cursor ? decodeCollectionCursor(input.cursor, cursorScope) : null;
      const rows = await database
        .select({
          appliedMode: aiProposals.appliedMode,
          command: aiProposals.command,
          createdAt: aiProposals.createdAt,
          defaultApplyMode: aiProposals.defaultApplyMode,
          explanation: sql<string>`substr(${aiProposals.explanation}, 1, 500)`,
          id: aiProposals.id,
          isTruncated: sql<number>`case when length(${aiProposals.targetText}) > 500 or length(${aiProposals.replacementText}) > 2000 or length(${aiProposals.explanation}) > 500 then 1 else 0 end`,
          occurrenceIndex: aiProposals.occurrenceIndex,
          replacementText: sql<string>`substr(${aiProposals.replacementText}, 1, 2000)`,
          source: aiProposals.source,
          status: aiProposals.status,
          targetFrom: aiProposals.targetFrom,
          targetText: sql<string>`substr(${aiProposals.targetText}, 1, 500)`,
          targetTo: aiProposals.targetTo,
        })
        .from(aiProposals)
        .where(and(
          eq(aiProposals.workspaceId, scope.workspaceId),
          eq(aiProposals.documentId, documentId),
          cursor
            ? or(
                lt(aiProposals.createdAt, cursor.timestamp),
                and(eq(aiProposals.createdAt, cursor.timestamp), lt(aiProposals.id, cursor.id)),
              )
            : undefined,
        ))
        .orderBy(desc(aiProposals.createdAt), desc(aiProposals.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((row) => ({
        ...row,
        isTruncated: Boolean(row.isTruncated),
      }));
      return {
        items,
        nextCursor: rows.length > limit && items.length > 0
          ? encodeCollectionCursor({ id: items.at(-1)!.id, timestamp: items.at(-1)!.createdAt }, cursorScope)
          : null,
      };
    },

    async getProposalById(scope: WorkspaceScope, id: string) {
      const [proposal] = await database
        .select()
        .from(aiProposals)
        .where(and(eq(aiProposals.workspaceId, scope.workspaceId), eq(aiProposals.id, id)))
        .limit(1);
      return proposal ?? null;
    },

    async updateProposalStatus(
      scope: WorkspaceScope,
      id: string,
      status: "pending" | "accepted" | "rejected",
      _appliedMode?: "replace" | "insert_below",
      options: { expectedStatus?: "pending" | "accepted" | "rejected" } = {},
    ) {
      if (status === "accepted") return null;

      return database.transaction(async (transaction) => {
        const whereClause = options.expectedStatus
          ? and(
              eq(aiProposals.workspaceId, scope.workspaceId),
              eq(aiProposals.id, id),
              inArray(aiProposals.status, ["pending", "rejected"]),
              eq(aiProposals.status, options.expectedStatus),
            )
          : and(
              eq(aiProposals.workspaceId, scope.workspaceId),
              eq(aiProposals.id, id),
              inArray(aiProposals.status, ["pending", "rejected"]),
            );
        const [candidate] = await transaction
          .select({ documentId: aiProposals.documentId, status: aiProposals.status })
          .from(aiProposals)
          .where(whereClause)
          .limit(1);
        if (!candidate) return null;

        if (candidate.status === "rejected" && status === "pending") {
          const [currentCollaboration] = await transaction
            .select({ generation: collaborationDocuments.generation })
            .from(collaborationDocuments)
            .where(and(
              eq(collaborationDocuments.workspaceId, scope.workspaceId),
              eq(collaborationDocuments.documentId, candidate.documentId),
              eq(collaborationDocuments.isCurrent, true),
            ))
            .limit(1);
          if (currentCollaboration) {
            const [exactAnchor] = await transaction
              .select({ proposalId: collaborationProposalAnchors.proposalId })
              .from(collaborationProposalAnchors)
              .where(and(
                eq(collaborationProposalAnchors.workspaceId, scope.workspaceId),
                eq(collaborationProposalAnchors.proposalId, id),
                eq(collaborationProposalAnchors.documentId, candidate.documentId),
                eq(collaborationProposalAnchors.generation, currentCollaboration.generation),
              ))
              .limit(1);
            if (!exactAnchor) throw new ProposalStatusUpdateConflictError();
          }
        }

        const [proposal] = await transaction
          .update(aiProposals)
          .set({
            appliedMode: null,
            status,
            updatedAt: new Date(),
          })
          .where(whereClause)
          .returning();

        return proposal ?? null;
      });
    },
  };
}

function normalizePageLimit(value: number | undefined) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(value ?? 20, 50)) : 20;
}

const defaultRepository = createProposalRepository();

export const createProposal = defaultRepository.createProposal;
export const getProposalById = defaultRepository.getProposalById;
export const listProposalsForDocument = defaultRepository.listProposalsForDocument;
export const listProposalSummariesPage = defaultRepository.listProposalSummariesPage;
export const updateProposalStatus = defaultRepository.updateProposalStatus;
