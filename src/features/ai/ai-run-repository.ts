import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns } from "@/db/schema";

export async function listAiRunsForDocument(documentId: string) {
  return db.select().from(aiRuns).where(eq(aiRuns.documentId, documentId)).orderBy(desc(aiRuns.createdAt));
}
