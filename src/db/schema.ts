import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

export type TiptapJson = {
  type: "doc";
  content?: unknown[];
};

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    title: text("title").notNull(),
    contentJson: text("content_json", { mode: "json" }).$type<TiptapJson>().notNull(),
    plainText: text("plain_text").notNull().default(""),
    status: text("status", { enum: ["draft", "archived"] }).notNull().default("draft"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [check("documents_status_check", sql`${table.status} in ('draft', 'archived')`)],
);

export const promptTemplates = sqliteTable("prompt_templates", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  variableSchemaJson: text("variable_schema_json", { mode: "json" }).$type<PromptVariableSchema>().notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const aiRuns = sqliteTable(
  "ai_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    promptTemplateId: text("prompt_template_id").references(() => promptTemplates.id, { onDelete: "set null" }),
    commandType: text("command_type", { enum: ["selection_rewrite", "document_review"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputSummaryJson: text("input_summary_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    outputText: text("output_text").notNull().default(""),
    status: text("status", { enum: ["pending", "streaming", "completed", "failed"] }).notNull(),
    wasApplied: integer("was_applied", { mode: "boolean" }).notNull().default(false),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_runs_document_id_idx").on(table.documentId),
    index("ai_runs_prompt_template_id_idx").on(table.promptTemplateId),
    check("ai_runs_command_type_check", sql`${table.commandType} in ('selection_rewrite', 'document_review')`),
    check("ai_runs_status_check", sql`${table.status} in ('pending', 'streaming', 'completed', 'failed')`),
  ],
);

export const aiProposals = sqliteTable(
  "ai_proposals",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    aiRunId: text("ai_run_id").notNull().references(() => aiRuns.id, { onDelete: "cascade" }),
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    targetText: text("target_text").notNull(),
    replacementText: text("replacement_text").notNull(),
    explanation: text("explanation").notNull(),
    status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_proposals_ai_run_id_idx").on(table.aiRunId),
    index("ai_proposals_document_id_idx").on(table.documentId),
    check("ai_proposals_status_check", sql`${table.status} in ('pending', 'accepted', 'rejected')`),
  ],
);

export type PromptVariableSchema = {
  fields: Array<{
    name: string;
    label: string;
    type: "text" | "textarea" | "select";
    required: boolean;
    options?: string[];
  }>;
  required: string[];
};

export type DocumentRecord = typeof documents.$inferSelect;
export type NewDocumentRecord = typeof documents.$inferInsert;
export type PromptTemplateRecord = typeof promptTemplates.$inferSelect;
export type NewPromptTemplateRecord = typeof promptTemplates.$inferInsert;
export type AiRunRecord = typeof aiRuns.$inferSelect;
export type NewAiRunRecord = typeof aiRuns.$inferInsert;
export type AiProposalRecord = typeof aiProposals.$inferSelect;
export type NewAiProposalRecord = typeof aiProposals.$inferInsert;
