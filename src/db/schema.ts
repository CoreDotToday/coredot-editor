import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

export type TiptapJson = {
  type: "doc";
  content?: unknown[];
};

export type DocumentReadiness = "draft" | "needs_review" | "ready" | "approved";
export type DocumentMetadataValue = boolean | number | string | string[] | null;
export type DocumentMetadata = Record<string, DocumentMetadataValue>;

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    contentJson: text("content_json", { mode: "json" }).$type<TiptapJson>().notNull(),
    plainText: text("plain_text").notNull().default(""),
    status: text("status", { enum: ["draft", "archived"] }).notNull().default("draft"),
    readiness: text("readiness", { enum: ["draft", "needs_review", "ready", "approved"] })
      .notNull()
      .default("draft"),
    metadataJson: text("metadata_json", { mode: "json" })
      .$type<DocumentMetadata>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("documents_readiness_idx").on(table.readiness),
    index("documents_workspace_status_updated_idx").on(table.workspaceId, table.status, table.updatedAt),
    check("documents_status_check", sql`${table.status} in ('draft', 'archived')`),
    check("documents_readiness_check", sql`${table.readiness} in ('draft', 'needs_review', 'ready', 'approved')`),
  ],
);

export const promptTemplates = sqliteTable(
  "prompt_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    variableSchemaJson: text("variable_schema_json", { mode: "json" }).$type<PromptVariableSchema>().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("prompt_templates_workspace_active_name_idx").on(table.workspaceId, table.isActive, table.name)],
);

export const aiRuns = sqliteTable(
  "ai_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
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
    index("ai_runs_workspace_document_created_idx").on(table.workspaceId, table.documentId, table.createdAt),
    check("ai_runs_command_type_check", sql`${table.commandType} in ('selection_rewrite', 'document_review')`),
    check("ai_runs_status_check", sql`${table.status} in ('pending', 'streaming', 'completed', 'failed')`),
  ],
);

export const aiProposals = sqliteTable(
  "ai_proposals",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    aiRunId: text("ai_run_id").notNull().references(() => aiRuns.id, { onDelete: "cascade" }),
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    targetText: text("target_text").notNull(),
    replacementText: text("replacement_text").notNull(),
    explanation: text("explanation").notNull(),
    source: text("source", { enum: ["selection", "review"] }).notNull().default("review"),
    command: text("command"),
    occurrenceIndex: integer("occurrence_index"),
    targetFrom: integer("target_from"),
    targetTo: integer("target_to"),
    defaultApplyMode: text("default_apply_mode", { enum: ["replace", "insert_below"] }).notNull().default("replace"),
    appliedMode: text("applied_mode", { enum: ["replace", "insert_below"] }),
    status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_proposals_ai_run_id_idx").on(table.aiRunId),
    index("ai_proposals_document_id_idx").on(table.documentId),
    index("ai_proposals_workspace_document_created_idx").on(table.workspaceId, table.documentId, table.createdAt),
    check("ai_proposals_source_check", sql`${table.source} in ('selection', 'review')`),
    check("ai_proposals_default_apply_mode_check", sql`${table.defaultApplyMode} in ('replace', 'insert_below')`),
    check(
      "ai_proposals_applied_mode_check",
      sql`${table.appliedMode} is null or ${table.appliedMode} in ('replace', 'insert_below')`,
    ),
    check("ai_proposals_status_check", sql`${table.status} in ('pending', 'accepted', 'rejected')`),
  ],
);

export const appSettings = sqliteTable(
  "app_settings",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    aiProvider: text("ai_provider", { enum: ["stub", "openai", "coredot", "anthropic", "gemini"] })
      .notNull()
      .default("stub"),
    aiModel: text("ai_model").notNull().default("stub-editor"),
    aiBaseUrl: text("ai_base_url"),
    aiMaxCompletionTokens: integer("ai_max_completion_tokens"),
    aiReasoningEffort: text("ai_reasoning_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("app_settings_workspace_id_unique").on(table.workspaceId),
    check(
      "app_settings_ai_provider_check",
      sql`${table.aiProvider} in ('stub', 'openai', 'coredot', 'anthropic', 'gemini')`,
    ),
    check(
      "app_settings_ai_reasoning_effort_check",
      sql`${table.aiReasoningEffort} is null or ${table.aiReasoningEffort} in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
    ),
    check(
      "app_settings_ai_max_completion_tokens_check",
      sql`${table.aiMaxCompletionTokens} is null or ${table.aiMaxCompletionTokens} > 0`,
    ),
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
export type AppSettingsRecord = typeof appSettings.$inferSelect;
export type NewAppSettingsRecord = typeof appSettings.$inferInsert;
