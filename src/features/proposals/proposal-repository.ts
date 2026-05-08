import { db } from "@/db/client";
import { aiProposals, type NewAiProposalRecord } from "@/db/schema";

type ProposalDatabase = typeof db;

type CreateProposalInput = Pick<
  NewAiProposalRecord,
  "aiRunId" | "documentId" | "targetText" | "replacementText" | "explanation"
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
  };
}

const defaultRepository = createProposalRepository();

export const createProposal = defaultRepository.createProposal;
