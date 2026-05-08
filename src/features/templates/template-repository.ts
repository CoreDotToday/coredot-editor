import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptTemplates, type NewPromptTemplateRecord, type PromptTemplateRecord } from "@/db/schema";

type PromptTemplateInput = Pick<
  NewPromptTemplateRecord,
  "name" | "description" | "category" | "systemPrompt" | "variableSchemaJson"
>;

type PromptTemplateUpdateInput = PromptTemplateInput & Pick<PromptTemplateRecord, "isActive">;

export async function listActivePromptTemplates() {
  return db.select().from(promptTemplates).where(eq(promptTemplates.isActive, true)).orderBy(asc(promptTemplates.name));
}

export async function listPromptTemplates() {
  return db.select().from(promptTemplates).orderBy(asc(promptTemplates.name));
}

export async function getPromptTemplateById(id: string) {
  const [template] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1);
  return template ?? null;
}

export async function createPromptTemplate(input: PromptTemplateInput) {
  const now = new Date();
  const [template] = await db
    .insert(promptTemplates)
    .values({
      ...input,
      isDefault: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return template;
}

export async function updatePromptTemplate(id: string, input: PromptTemplateUpdateInput) {
  const [template] = await db
    .update(promptTemplates)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(promptTemplates.id, id))
    .returning();

  return template ?? null;
}

export async function archivePromptTemplate(id: string) {
  const [template] = await db
    .update(promptTemplates)
    .set({
      isActive: false,
      updatedAt: new Date(),
    })
    .where(eq(promptTemplates.id, id))
    .returning();

  return template ?? null;
}
