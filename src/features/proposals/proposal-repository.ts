import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { aiProposals, type NewAiProposalRecord } from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";

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
        .orderBy(desc(aiProposals.createdAt));
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
      const [proposal] = await database
        .update(aiProposals)
        .set({
          appliedMode: null,
          status,
          updatedAt: new Date(),
        })
        .where(whereClause)
        .returning();

      return proposal ?? null;
    },
  };
}

const defaultRepository = createProposalRepository();

export const createProposal = defaultRepository.createProposal;
export const getProposalById = defaultRepository.getProposalById;
export const listProposalsForDocument = defaultRepository.listProposalsForDocument;
export const updateProposalStatus = defaultRepository.updateProposalStatus;
