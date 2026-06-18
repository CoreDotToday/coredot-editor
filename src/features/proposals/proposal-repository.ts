import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiProposals, type NewAiProposalRecord } from "@/db/schema";

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
    async createProposal(input: CreateProposalInput) {
      const now = new Date();
      const [proposal] = await database
        .insert(aiProposals)
        .values({
          ...input,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return proposal!;
    },

    async listProposalsForDocument(documentId: string) {
      return database
        .select()
        .from(aiProposals)
        .where(eq(aiProposals.documentId, documentId))
        .orderBy(desc(aiProposals.createdAt));
    },

    async getProposalById(id: string) {
      const [proposal] = await database.select().from(aiProposals).where(eq(aiProposals.id, id)).limit(1);
      return proposal ?? null;
    },

    async updateProposalStatus(
      id: string,
      status: "pending" | "accepted" | "rejected",
      appliedMode?: "replace" | "insert_below",
      options: { expectedStatus?: "pending" | "accepted" | "rejected" } = {},
    ) {
      const whereClause = options.expectedStatus
        ? and(eq(aiProposals.id, id), eq(aiProposals.status, options.expectedStatus))
        : eq(aiProposals.id, id);
      const [proposal] = await database
        .update(aiProposals)
        .set({
          appliedMode: status === "accepted" ? appliedMode ?? null : null,
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
