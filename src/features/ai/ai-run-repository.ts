import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiProposals, aiRuns, type NewAiProposalRecord, type NewAiRunRecord } from "@/db/schema";

type AiRunDatabase = typeof db;

type CreateAiRunInput = Pick<
  NewAiRunRecord,
  "documentId" | "promptTemplateId" | "commandType" | "provider" | "model" | "inputSummaryJson"
>;

type FinalizeAiRunProposalInput = Pick<
  NewAiProposalRecord,
  "documentId" | "targetText" | "replacementText" | "explanation"
> &
  Partial<
    Pick<
      NewAiProposalRecord,
      "source" | "command" | "occurrenceIndex" | "targetFrom" | "targetTo" | "defaultApplyMode"
    >
  >;

export function createAiRunRepository(database: AiRunDatabase = db) {
  return {
    async createAiRun(input: CreateAiRunInput) {
      const now = new Date();
      const [run] = await database
        .insert(aiRuns)
        .values({
          ...input,
          outputText: "",
          status: "pending",
          wasApplied: false,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return run!;
    },

    async completeAiRun(id: string, outputText: string) {
      const [run] = await database
        .update(aiRuns)
        .set({
          outputText,
          status: "completed",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(aiRuns.id, id))
        .returning();

      return run ?? null;
    },

    async completeAiRunWithProposals(id: string, outputText: string, proposals: FinalizeAiRunProposalInput[]) {
      return database.transaction(async (transaction) => {
        const now = new Date();
        const [run] = await transaction
          .update(aiRuns)
          .set({
            outputText,
            status: "completed",
            errorMessage: null,
            updatedAt: now,
          })
          .where(eq(aiRuns.id, id))
          .returning();

        if (!run) {
          return null;
        }

        if (proposals.length === 0) {
          return { run, proposals: [] };
        }

        const savedProposals = await transaction
          .insert(aiProposals)
          .values(
            proposals.map((proposal) => ({
              ...proposal,
              aiRunId: id,
              status: "pending" as const,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .returning();

        return { run, proposals: savedProposals };
      });
    },

    async failAiRun(id: string, errorMessage: string) {
      const [run] = await database
        .update(aiRuns)
        .set({
          status: "failed",
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(aiRuns.id, id))
        .returning();

      return run ?? null;
    },

    async listAiRunsForDocument(documentId: string) {
      return database.select().from(aiRuns).where(eq(aiRuns.documentId, documentId)).orderBy(desc(aiRuns.createdAt));
    },
  };
}

const defaultRepository = createAiRunRepository();

export const createAiRun = defaultRepository.createAiRun;
export const completeAiRun = defaultRepository.completeAiRun;
export const completeAiRunWithProposals = defaultRepository.completeAiRunWithProposals;
export const failAiRun = defaultRepository.failAiRun;
export const listAiRunsForDocument = defaultRepository.listAiRunsForDocument;
