import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptTemplates, type NewPromptTemplateRecord, type PromptTemplateRecord } from "@/db/schema";

type PromptTemplateInput = Pick<
  NewPromptTemplateRecord,
  "name" | "description" | "category" | "systemPrompt" | "variableSchemaJson"
>;

type PromptTemplateUpdateInput = PromptTemplateInput & Pick<PromptTemplateRecord, "isActive">;

type PromptTemplateDatabase = typeof db;

export function createPromptTemplateRepository(database: PromptTemplateDatabase = db) {
  return {
    async listActivePromptTemplates() {
      return database
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.isActive, true))
        .orderBy(asc(promptTemplates.name));
    },

    async listPromptTemplates() {
      return database
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.isActive, true))
        .orderBy(asc(promptTemplates.name));
    },

    async getPromptTemplateById(id: string) {
      const [template] = await database.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1);
      return template ?? null;
    },

    async createPromptTemplate(input: PromptTemplateInput) {
      const now = new Date();
      const [template] = await database
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
    },

    async updatePromptTemplate(id: string, input: PromptTemplateUpdateInput) {
      const [template] = await database
        .update(promptTemplates)
        .set({
          ...input,
          updatedAt: new Date(),
        })
        .where(eq(promptTemplates.id, id))
        .returning();

      return template ?? null;
    },

    async archivePromptTemplate(id: string) {
      const [template] = await database
        .update(promptTemplates)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(promptTemplates.id, id))
        .returning();

      return template ?? null;
    },
  };
}

const defaultRepository = createPromptTemplateRepository();

export const listActivePromptTemplates = defaultRepository.listActivePromptTemplates;
export const listPromptTemplates = defaultRepository.listPromptTemplates;
export const getPromptTemplateById = defaultRepository.getPromptTemplateById;
export const createPromptTemplate = defaultRepository.createPromptTemplate;
export const updatePromptTemplate = defaultRepository.updatePromptTemplate;
export const archivePromptTemplate = defaultRepository.archivePromptTemplate;
