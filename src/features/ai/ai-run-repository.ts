import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns, type NewAiRunRecord } from "@/db/schema";

type AiRunDatabase = typeof db;

type CreateAiRunInput = Pick<
  NewAiRunRecord,
  "documentId" | "promptTemplateId" | "commandType" | "provider" | "model" | "inputSummaryJson"
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
export const failAiRun = defaultRepository.failAiRun;
export const listAiRunsForDocument = defaultRepository.listAiRunsForDocument;
