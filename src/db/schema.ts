import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

export type TiptapJson = {
  type: "doc";
  content?: unknown[];
};

export type DocumentReadiness = "draft" | "needs_review" | "ready" | "approved";
export type DocumentMetadataValue = boolean | number | string | string[] | null;
export type DocumentMetadata = Record<string, DocumentMetadataValue>;
export type DocumentChangeSnapshot = {
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
};

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    creationKey: text("creation_key"),
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
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("documents_readiness_idx").on(table.readiness),
    index("documents_workspace_status_updated_idx").on(table.workspaceId, table.status, table.updatedAt),
    uniqueIndex("documents_workspace_creation_key_unique").on(table.workspaceId, table.creationKey),
    uniqueIndex("documents_workspace_id_id_unique").on(table.workspaceId, table.id),
    check("documents_status_check", sql`${table.status} in ('draft', 'archived')`),
    check("documents_readiness_check", sql`${table.readiness} in ('draft', 'needs_review', 'ready', 'approved')`),
    check("documents_revision_check", sql`${table.revision} >= 0`),
  ],
);

export const promptTemplates = sqliteTable(
  "prompt_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    builtinKey: text("builtin_key"),
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
  (table) => [
    index("prompt_templates_workspace_active_name_idx").on(table.workspaceId, table.isActive, table.name),
    uniqueIndex("prompt_templates_workspace_id_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("prompt_templates_workspace_builtin_key_unique").on(table.workspaceId, table.builtinKey),
  ],
);

export const aiRuns = sqliteTable(
  "ai_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    promptTemplateId: text("prompt_template_id").references(() => promptTemplates.id, { onDelete: "set null" }),
    commandType: text("command_type", { enum: ["selection_rewrite", "document_review"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    idempotencyKey: text("idempotency_key"),
    operationFingerprint: text("operation_fingerprint"),
    retryNotBeforeAt: integer("retry_not_before_at", { mode: "timestamp_ms" }),
    executionToken: text("execution_token"),
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
    index("ai_runs_status_updated_idx").on(table.status, table.updatedAt),
    index("ai_runs_workspace_document_created_idx").on(table.workspaceId, table.documentId, table.createdAt),
    uniqueIndex("ai_runs_workspace_idempotency_key_unique").on(table.workspaceId, table.idempotencyKey),
    uniqueIndex("ai_runs_workspace_id_id_document_id_unique").on(table.workspaceId, table.id, table.documentId),
    foreignKey({
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
      name: "ai_runs_workspace_document_fk",
    }).onDelete("cascade"),
    check("ai_runs_command_type_check", sql`${table.commandType} in ('selection_rewrite', 'document_review')`),
    check("ai_runs_status_check", sql`${table.status} in ('pending', 'streaming', 'completed', 'failed')`),
  ],
);

export const aiProposals = sqliteTable(
  "ai_proposals",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    aiRunId: text("ai_run_id").notNull(),
    documentId: text("document_id").notNull(),
    targetText: text("target_text").notNull(),
    replacementText: text("replacement_text").notNull(),
    explanation: text("explanation").notNull(),
    source: text("source", { enum: ["selection", "review"] }).notNull().default("review"),
    command: text("command"),
    occurrenceIndex: integer("occurrence_index"),
    targetFrom: integer("target_from"),
    targetTo: integer("target_to"),
    defaultApplyMode: text("default_apply_mode", { enum: ["replace", "insert_below"] }).notNull().default("replace"),
    resultOrdinal: integer("result_ordinal"),
    appliedMode: text("applied_mode", { enum: ["replace", "insert_below"] }),
    status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_proposals_ai_run_id_idx").on(table.aiRunId),
    index("ai_proposals_document_id_idx").on(table.documentId),
    index("ai_proposals_workspace_document_created_idx").on(table.workspaceId, table.documentId, table.createdAt),
    uniqueIndex("ai_proposals_workspace_run_result_ordinal_unique").on(
      table.workspaceId,
      table.aiRunId,
      table.resultOrdinal,
    ),
    uniqueIndex("ai_proposals_workspace_id_id_document_id_unique").on(table.workspaceId, table.id, table.documentId),
    foreignKey({
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
      name: "ai_proposals_workspace_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.aiRunId, table.documentId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id, aiRuns.documentId],
      name: "ai_proposals_workspace_run_document_fk",
    }).onDelete("cascade"),
    check("ai_proposals_source_check", sql`${table.source} in ('selection', 'review')`),
    check("ai_proposals_default_apply_mode_check", sql`${table.defaultApplyMode} in ('replace', 'insert_below')`),
    check(
      "ai_proposals_applied_mode_check",
      sql`${table.appliedMode} is null or ${table.appliedMode} in ('replace', 'insert_below')`,
    ),
    check("ai_proposals_status_check", sql`${table.status} in ('pending', 'accepted', 'rejected')`),
  ],
);

export type AiWorkspaceConversationStatus = "failed" | "idle";

export const aiWorkspaceConversations = sqliteTable(
  "ai_workspace_conversations",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    creationKey: text("creation_key").notNull(),
    creationFingerprint: text("creation_fingerprint").notNull(),
    title: text("title").notNull(),
    command: text("command").notNull(),
    status: text("status", { enum: ["idle", "failed"] }).notNull().default("idle"),
    version: integer("version").notNull().default(1),
    messageCount: integer("message_count").notNull().default(1),
    latestAiRunId: text("latest_ai_run_id"),
    latestProposalId: text("latest_proposal_id"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    retentionExpiresAt: integer("retention_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("ai_workspace_conversations_workspace_id_document_unique").on(
      table.workspaceId,
      table.id,
      table.documentId,
    ),
    uniqueIndex("ai_workspace_conversations_workspace_creation_key_unique").on(
      table.workspaceId,
      table.creationKey,
    ),
    index("ai_workspace_conversations_workspace_document_updated_idx").on(
      table.workspaceId,
      table.documentId,
      table.archivedAt,
      table.updatedAt,
      table.id,
    ),
    index("ai_workspace_conversations_retention_expires_idx").on(table.retentionExpiresAt),
    foreignKey({
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
      name: "ai_workspace_conversations_workspace_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.latestAiRunId, table.documentId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id, aiRuns.documentId],
      name: "ai_workspace_conversations_latest_run_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.latestProposalId, table.documentId],
      foreignColumns: [aiProposals.workspaceId, aiProposals.id, aiProposals.documentId],
      name: "ai_workspace_conversations_latest_proposal_fk",
    }),
    check("ai_workspace_conversations_status_check", sql`${table.status} in ('idle', 'failed')`),
    check("ai_workspace_conversations_version_check", sql`${table.version} >= 1`),
    check("ai_workspace_conversations_message_count_check", sql`${table.messageCount} >= 1`),
    check(
      "ai_workspace_conversations_retention_check",
      sql`${table.retentionExpiresAt} is null or ${table.retentionExpiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const aiWorkspaceMessages = sqliteTable(
  "ai_workspace_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    documentId: text("document_id").notNull(),
    mutationKey: text("mutation_key").notNull(),
    mutationFingerprint: text("mutation_fingerprint").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: text("role", { enum: ["assistant", "user"] }).notNull(),
    content: text("content").notNull(),
    command: text("command"),
    scopeLabel: text("scope_label"),
    aiRunId: text("ai_run_id"),
    proposalId: text("proposal_id"),
    retentionExpiresAt: integer("retention_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("ai_workspace_messages_conversation_ordinal_unique").on(
      table.workspaceId,
      table.conversationId,
      table.ordinal,
    ),
    uniqueIndex("ai_workspace_messages_conversation_mutation_key_unique").on(
      table.workspaceId,
      table.conversationId,
      table.mutationKey,
    ),
    index("ai_workspace_messages_workspace_run_idx").on(table.workspaceId, table.aiRunId),
    index("ai_workspace_messages_workspace_proposal_idx").on(table.workspaceId, table.proposalId),
    index("ai_workspace_messages_retention_expires_idx").on(table.retentionExpiresAt),
    foreignKey({
      columns: [table.workspaceId, table.conversationId, table.documentId],
      foreignColumns: [aiWorkspaceConversations.workspaceId, aiWorkspaceConversations.id, aiWorkspaceConversations.documentId],
      name: "ai_workspace_messages_conversation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.aiRunId, table.documentId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id, aiRuns.documentId],
      name: "ai_workspace_messages_run_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.proposalId, table.documentId],
      foreignColumns: [aiProposals.workspaceId, aiProposals.id, aiProposals.documentId],
      name: "ai_workspace_messages_proposal_fk",
    }),
    check("ai_workspace_messages_ordinal_check", sql`${table.ordinal} >= 0`),
    check("ai_workspace_messages_role_check", sql`${table.role} in ('assistant', 'user')`),
  ],
);

export const documentChanges = sqliteTable(
  "document_changes",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    principalId: text("principal_id").notNull(),
    requestId: text("request_id").notNull(),
    kind: text("kind", { enum: ["single", "batch"] }).notNull(),
    batchId: text("batch_id"),
    beforeSnapshotJson: text("before_snapshot_json", { mode: "json" }).$type<DocumentChangeSnapshot>().notNull(),
    afterRevision: integer("after_revision").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("document_changes_workspace_document_created_idx").on(table.workspaceId, table.documentId, table.createdAt),
    uniqueIndex("document_changes_workspace_id_document_unique").on(table.workspaceId, table.id, table.documentId),
    foreignKey({
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
      name: "document_changes_workspace_document_fk",
    }).onDelete("cascade"),
    check("document_changes_kind_check", sql`${table.kind} in ('single', 'batch')`),
    check("document_changes_after_revision_check", sql`${table.afterRevision} > 0`),
    check(
      "document_changes_batch_id_check",
      sql`(${table.kind} = 'single' and ${table.batchId} is null) or (${table.kind} = 'batch' and ${table.batchId} is not null)`,
    ),
  ],
);

export const documentChangeProposals = sqliteTable(
  "document_change_proposals",
  {
    workspaceId: text("workspace_id").notNull(),
    changeId: text("change_id").notNull(),
    documentId: text("document_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    appliedMode: text("applied_mode", { enum: ["replace", "insert_below"] }).notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.changeId, table.proposalId],
      name: "document_change_proposals_pk",
    }),
    uniqueIndex("document_change_proposals_workspace_change_ordinal_unique").on(
      table.workspaceId,
      table.changeId,
      table.ordinal,
    ),
    index("document_change_proposals_workspace_proposal_idx").on(table.workspaceId, table.proposalId),
    foreignKey({
      columns: [table.workspaceId, table.changeId, table.documentId],
      foreignColumns: [documentChanges.workspaceId, documentChanges.id, documentChanges.documentId],
      name: "document_change_proposals_change_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.proposalId, table.documentId],
      foreignColumns: [aiProposals.workspaceId, aiProposals.id, aiProposals.documentId],
      name: "document_change_proposals_proposal_fk",
    }).onDelete("cascade"),
    check("document_change_proposals_mode_check", sql`${table.appliedMode} in ('replace', 'insert_below')`),
    check("document_change_proposals_ordinal_check", sql`${table.ordinal} >= 0`),
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

export const requestBudgetBuckets = sqliteTable(
  "request_budget_buckets",
  {
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    policyId: text("policy_id").notNull(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.principalId, table.policyId, table.windowStart],
      name: "request_budget_buckets_pk",
    }),
    index("request_budget_buckets_expires_at_idx").on(table.expiresAt),
    check("request_budget_buckets_request_count_check", sql`${table.requestCount} > 0`),
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
type AiProposalDatabaseRecord = typeof aiProposals.$inferSelect;
export type AiProposalRecord = Omit<AiProposalDatabaseRecord, "resultOrdinal"> & {
  resultOrdinal?: number | null;
};
export type NewAiProposalRecord = typeof aiProposals.$inferInsert;
export type AiWorkspaceConversationRecord = typeof aiWorkspaceConversations.$inferSelect;
export type NewAiWorkspaceConversationRecord = typeof aiWorkspaceConversations.$inferInsert;
export type AiWorkspaceMessageRecord = typeof aiWorkspaceMessages.$inferSelect;
export type NewAiWorkspaceMessageRecord = typeof aiWorkspaceMessages.$inferInsert;
export type DocumentChangeRecord = typeof documentChanges.$inferSelect;
export type NewDocumentChangeRecord = typeof documentChanges.$inferInsert;
export type DocumentChangeProposalRecord = typeof documentChangeProposals.$inferSelect;
export type AppSettingsRecord = typeof appSettings.$inferSelect;
export type NewAppSettingsRecord = typeof appSettings.$inferInsert;
export type RequestBudgetBucketRecord = typeof requestBudgetBuckets.$inferSelect;
