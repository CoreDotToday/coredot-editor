import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptTemplates } from "@/db/schema";

export async function listActivePromptTemplates() {
  return db.select().from(promptTemplates).where(eq(promptTemplates.isActive, true)).orderBy(asc(promptTemplates.name));
}
