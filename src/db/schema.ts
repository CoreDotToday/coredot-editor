import { sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

export type TiptapJson = {
  type: "doc";
  content?: unknown[];
};

export type DocumentReadiness = "draft" | "needs_review" | "ready" | "approved";
export type DocumentMetadataValue = boolean | number | string | string[] | null;
export type DocumentMetadata = Record<string, DocumentMetadataValue>;
export type CollaborationUpdateOriginKind = "client" | "migration" | "proposal_command" | "repair" | "undo_command";
export type CollaborationActionType = "proposal_apply" | "proposal_batch_apply" | "repair" | "selective_undo";
export type CollaborationActionStatus = "applied" | "failed" | "pending";
export const COLLABORATION_STORAGE_LIMITS = {
  codecBytes: 10 * 1024 * 1024,
  correctnessKeyBytes: 256,
  diagnosticJsonBytes: 4 * 1024,
  failureCategoryBytes: 128,
  relativePositionBytes: 64 * 1024,
  stateVectorBytes: 1024 * 1024,
  targetPreviewBytes: 1024,
} as const;
const COLLABORATION_STORAGE_LIMIT_SQL = Object.fromEntries(
  Object.entries(COLLABORATION_STORAGE_LIMITS).map(([key, value]) => [key, sql.raw(String(value))]),
) as Record<keyof typeof COLLABORATION_STORAGE_LIMITS, ReturnType<typeof sql.raw>>;
const COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL =
  sql`char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || ' '`;
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
    index("documents_workspace_status_updated_id_idx").on(table.workspaceId, table.status, table.updatedAt, table.id),
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
    index("ai_runs_workspace_document_created_id_idx").on(table.workspaceId, table.documentId, table.createdAt, table.id),
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
    index("ai_proposals_workspace_document_created_id_idx").on(table.workspaceId, table.documentId, table.createdAt, table.id),
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

export const collaborationDocuments = sqliteTable(
  "collaboration_documents",
  {
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    schemaVersion: integer("schema_version").notNull(),
    schemaFingerprint: text("schema_fingerprint").notNull(),
    checkpointBlob: blob("checkpoint_blob", { mode: "buffer" }).notNull(),
    checkpointChecksum: text("checkpoint_checksum").notNull(),
    headSeq: integer("head_seq").notNull().default(0),
    checkpointSeq: integer("checkpoint_seq").notNull().default(0),
    projectedSeq: integer("projected_seq").notNull().default(0),
    lastCheckpointAt: integer("last_checkpoint_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      name: "collaboration_documents_pk",
    }),
    uniqueIndex("collaboration_documents_current_unique")
      .on(table.workspaceId, table.documentId)
      .where(sql`${table.isCurrent} = 1`),
    index("collaboration_documents_workspace_document_generation_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
      name: "collaboration_documents_workspace_document_fk",
    }).onDelete("cascade"),
    check(
      "collaboration_documents_generation_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991`,
    ),
    check(
      "collaboration_documents_is_current_check",
      sql`typeof(${table.isCurrent}) = 'integer' and ${table.isCurrent} in (0, 1)`,
    ),
    check(
      "collaboration_documents_schema_version_check",
      sql`typeof(${table.schemaVersion}) = 'integer' and ${table.schemaVersion} between 1 and 9007199254740991`,
    ),
    check(
      "collaboration_documents_sequence_check",
      sql`typeof(${table.headSeq}) = 'integer' and ${table.headSeq} between 0 and 9007199254740991
        and typeof(${table.checkpointSeq}) = 'integer' and ${table.checkpointSeq} between 0 and 9007199254740991
        and typeof(${table.projectedSeq}) = 'integer' and ${table.projectedSeq} between 0 and 9007199254740991
        and ${table.checkpointSeq} <= ${table.projectedSeq}
        and ${table.projectedSeq} <= ${table.headSeq}`,
    ),
    check(
      "collaboration_documents_schema_fingerprint_check",
      sql`typeof(${table.schemaFingerprint}) = 'text'
        and length(${table.schemaFingerprint}) = 64
        and ${table.schemaFingerprint} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_documents_checkpoint_checksum_check",
      sql`typeof(${table.checkpointChecksum}) = 'text'
        and length(${table.checkpointChecksum}) = 64
        and ${table.checkpointChecksum} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_documents_checkpoint_blob_check",
      sql`typeof(${table.checkpointBlob}) = 'blob'
        and length(${table.checkpointBlob}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.codecBytes}`,
    ),
  ],
);

export const collaborationActions = sqliteTable(
  "collaboration_actions",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    commandId: text("command_id").notNull(),
    actionType: text("action_type", {
      enum: ["proposal_apply", "proposal_batch_apply", "selective_undo", "repair"],
    }).notNull(),
    principalId: text("principal_id").notNull(),
    requestId: text("request_id").notNull(),
    baseHeadSeq: integer("base_head_seq").notNull(),
    appliedHeadSeq: integer("applied_head_seq"),
    proposalId: text("proposal_id"),
    documentChangeId: text("document_change_id"),
    status: text("status", { enum: ["pending", "applied", "failed"] }).notNull(),
    failureCategory: text("failure_category"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("collaboration_actions_workspace_id_document_generation_unique").on(
      table.workspaceId,
      table.id,
      table.documentId,
      table.generation,
    ),
    uniqueIndex("collaboration_actions_workspace_command_unique").on(table.workspaceId, table.commandId),
    index("collaboration_actions_workspace_document_generation_created_id_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_actions_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.proposalId, table.documentId],
      foreignColumns: [aiProposals.workspaceId, aiProposals.id, aiProposals.documentId],
      name: "collaboration_actions_proposal_fk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.documentChangeId, table.documentId],
      foreignColumns: [documentChanges.workspaceId, documentChanges.id, documentChanges.documentId],
      name: "collaboration_actions_document_change_fk",
    }),
    check(
      "collaboration_actions_generation_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991`,
    ),
    check(
      "collaboration_actions_type_check",
      sql`${table.actionType} in ('proposal_apply', 'proposal_batch_apply', 'selective_undo', 'repair')`,
    ),
    check("collaboration_actions_status_check", sql`${table.status} in ('pending', 'applied', 'failed')`),
    check(
      "collaboration_actions_sequence_check",
      sql`typeof(${table.baseHeadSeq}) = 'integer' and ${table.baseHeadSeq} between 0 and 9007199254740991
        and (${table.appliedHeadSeq} is null or (
          typeof(${table.appliedHeadSeq}) = 'integer'
          and ${table.appliedHeadSeq} between 0 and 9007199254740991
          and ${table.appliedHeadSeq} >= ${table.baseHeadSeq}
        ))`,
    ),
    check(
      "collaboration_actions_state_check",
      sql`(${table.status} = 'pending' and ${table.appliedHeadSeq} is null and ${table.failureCategory} is null)
        or (${table.status} = 'applied' and ${table.appliedHeadSeq} is not null and ${table.failureCategory} is null)
        or (${table.status} = 'failed' and ${table.appliedHeadSeq} is null and ${table.failureCategory} is not null)`,
    ),
    check(
      "collaboration_actions_command_id_check",
      sql`typeof(${table.commandId}) = 'text'
        and ${table.commandId} = trim(${table.commandId}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
        and length(cast(${table.commandId} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}`,
    ),
    check(
      "collaboration_actions_failure_category_check",
      sql`${table.failureCategory} is null or (
        typeof(${table.failureCategory}) = 'text'
        and ${table.failureCategory} = trim(${table.failureCategory}, char(9) || char(10) || char(13) || ' ')
        and length(cast(${table.failureCategory} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.failureCategoryBytes}
      )`,
    ),
  ],
);

export const collaborationUpdates = sqliteTable(
  "collaboration_updates",
  {
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    seq: integer("seq").notNull(),
    updateBlob: blob("update_blob", { mode: "buffer" }).notNull(),
    checksum: text("checksum").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    originKind: text("origin_kind", {
      enum: ["client", "proposal_command", "undo_command", "migration", "repair"],
    }).notNull(),
    principalId: text("principal_id"),
    requestId: text("request_id"),
    sessionId: text("session_id"),
    semanticActionId: text("semantic_action_id"),
    diagnosticJson: text("diagnostic_json", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.documentId, table.generation, table.seq],
      name: "collaboration_updates_pk",
    }),
    uniqueIndex("collaboration_updates_document_generation_idempotency_unique").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_updates_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.semanticActionId, table.documentId, table.generation],
      foreignColumns: [
        collaborationActions.workspaceId,
        collaborationActions.id,
        collaborationActions.documentId,
        collaborationActions.generation,
      ],
      name: "collaboration_updates_semantic_action_fk",
    }),
    check(
      "collaboration_updates_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.seq}) = 'integer' and ${table.seq} between 1 and 9007199254740991`,
    ),
    check(
      "collaboration_updates_checksum_check",
      sql`typeof(${table.checksum}) = 'text'
        and length(${table.checksum}) = 64
        and ${table.checksum} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_updates_origin_check",
      sql`${table.originKind} in ('client', 'proposal_command', 'undo_command', 'migration', 'repair')`,
    ),
    check(
      "collaboration_updates_update_blob_check",
      sql`typeof(${table.updateBlob}) = 'blob'
        and length(${table.updateBlob}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.codecBytes}`,
    ),
    check(
      "collaboration_updates_idempotency_key_check",
      sql`typeof(${table.idempotencyKey}) = 'text'
        and ${table.idempotencyKey} = trim(${table.idempotencyKey}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
        and length(cast(${table.idempotencyKey} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}`,
    ),
    check(
      "collaboration_updates_diagnostic_json_check",
      sql`${table.diagnosticJson} is null or (
        typeof(${table.diagnosticJson}) = 'text'
        and length(cast(${table.diagnosticJson} as blob)) between 2 and ${COLLABORATION_STORAGE_LIMIT_SQL.diagnosticJsonBytes}
        and case when json_valid(${table.diagnosticJson})
          then json_type(${table.diagnosticJson}) = 'object'
          else 0
        end
      )`,
    ),
  ],
);

export const collaborationNoopReceipts = sqliteTable(
  "collaboration_noop_receipts",
  {
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    generation: integer("generation").notNull(),
    headSeq: integer("head_seq").notNull(),
    checksum: text("checksum").notNull(),
    originKind: text("origin_kind", {
      enum: ["client", "proposal_command", "undo_command", "migration", "repair"],
    }).notNull(),
    principalId: text("principal_id").notNull(),
    requestId: text("request_id"),
    sessionId: text("session_id"),
    semanticActionId: text("semantic_action_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.documentId, table.idempotencyKey],
      name: "collaboration_noop_receipts_pk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_noop_receipts_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.semanticActionId, table.documentId, table.generation],
      foreignColumns: [
        collaborationActions.workspaceId,
        collaborationActions.id,
        collaborationActions.documentId,
        collaborationActions.generation,
      ],
      name: "collaboration_noop_receipts_semantic_action_fk",
    }),
    check(
      "collaboration_noop_receipts_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.headSeq}) = 'integer' and ${table.headSeq} between 0 and 9007199254740991`,
    ),
    check(
      "collaboration_noop_receipts_checksum_check",
      sql`typeof(${table.checksum}) = 'text'
        and length(${table.checksum}) = 64
        and ${table.checksum} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_noop_receipts_origin_check",
      sql`${table.originKind} in ('client', 'proposal_command', 'undo_command', 'migration', 'repair')`,
    ),
    check(
      "collaboration_noop_receipts_idempotency_key_check",
      sql`typeof(${table.idempotencyKey}) = 'text'
        and ${table.idempotencyKey} = trim(${table.idempotencyKey}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
        and length(cast(${table.idempotencyKey} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}`,
    ),
    check(
      "collaboration_noop_receipts_audit_identity_check",
      sql`(${table.principalId} is null or (
          typeof(${table.principalId}) = 'text'
          and ${table.principalId} = trim(${table.principalId}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
          and length(cast(${table.principalId} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}
        )) and (${table.requestId} is null or (
          typeof(${table.requestId}) = 'text'
          and ${table.requestId} = trim(${table.requestId}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
          and length(cast(${table.requestId} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}
        )) and (${table.sessionId} is null or (
          typeof(${table.sessionId}) = 'text'
          and ${table.sessionId} = trim(${table.sessionId}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
          and length(cast(${table.sessionId} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}
        )) and (${table.semanticActionId} is null or (
          typeof(${table.semanticActionId}) = 'text'
          and ${table.semanticActionId} = trim(${table.semanticActionId}, ${COLLABORATION_KEY_BOUNDARY_WHITESPACE_SQL})
          and length(cast(${table.semanticActionId} as blob)) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.correctnessKeyBytes}
        ))`,
    ),
  ],
);

export const collaborationAuthorizationEpochs = sqliteTable(
  "collaboration_authorization_epochs",
  {
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    epoch: integer("epoch").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.principalId],
      name: "collaboration_authorization_epochs_pk",
    }),
    check(
      "collaboration_authorization_epochs_epoch_check",
      sql`typeof(${table.epoch}) = 'integer' and ${table.epoch} between 0 and 9007199254740991`,
    ),
  ],
);

export const documentApprovals = sqliteTable(
  "document_approvals",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    approvedHeadSeq: integer("approved_head_seq").notNull(),
    approvedStateVector: blob("approved_state_vector", { mode: "buffer" }).notNull(),
    approvedContentHash: text("approved_content_hash").notNull(),
    principalId: text("principal_id").notNull(),
    requestId: text("request_id").notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }).notNull(),
    invalidatedSeq: integer("invalidated_seq"),
    invalidatedPrincipalId: text("invalidated_principal_id"),
    invalidatedAt: integer("invalidated_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("document_approvals_active_document_unique")
      .on(table.workspaceId, table.documentId)
      .where(sql`${table.invalidatedAt} is null`),
    index("document_approvals_workspace_document_generation_approved_id_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.approvedAt,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "document_approvals_document_generation_fk",
    }).onDelete("cascade"),
    check(
      "document_approvals_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.approvedHeadSeq}) = 'integer'
        and ${table.approvedHeadSeq} between 0 and 9007199254740991`,
    ),
    check(
      "document_approvals_content_hash_check",
      sql`typeof(${table.approvedContentHash}) = 'text'
        and length(${table.approvedContentHash}) = 64
        and ${table.approvedContentHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "document_approvals_state_vector_check",
      sql`typeof(${table.approvedStateVector}) = 'blob'
        and length(${table.approvedStateVector}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.stateVectorBytes}`,
    ),
    check(
      "document_approvals_invalidation_check",
      sql`(${table.invalidatedSeq} is null and ${table.invalidatedPrincipalId} is null and ${table.invalidatedAt} is null)
        or (${table.invalidatedSeq} is not null and ${table.invalidatedPrincipalId} is not null
          and ${table.invalidatedAt} is not null
          and typeof(${table.invalidatedSeq}) = 'integer'
          and ${table.invalidatedSeq} between 1 and 9007199254740991
          and ${table.invalidatedSeq} > ${table.approvedHeadSeq})`,
    ),
  ],
);

export const collaborationProposalAnchors = sqliteTable(
  "collaboration_proposal_anchors",
  {
    workspaceId: text("workspace_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    schemaFingerprint: text("schema_fingerprint").notNull(),
    baseHeadSeq: integer("base_head_seq").notNull(),
    baseStateVector: blob("base_state_vector", { mode: "buffer" }).notNull(),
    startRelative: blob("start_relative", { mode: "buffer" }).notNull(),
    startAssoc: integer("start_assoc").notNull(),
    endRelative: blob("end_relative", { mode: "buffer" }).notNull(),
    endAssoc: integer("end_assoc").notNull(),
    targetHash: text("target_hash").notNull(),
    targetPreview: text("target_preview").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.proposalId],
      name: "collaboration_proposal_anchors_pk",
    }),
    index("collaboration_proposal_anchors_document_generation_history_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.createdAt,
      table.proposalId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_proposal_anchors_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.proposalId, table.documentId],
      foreignColumns: [aiProposals.workspaceId, aiProposals.id, aiProposals.documentId],
      name: "collaboration_proposal_anchors_proposal_fk",
    }).onDelete("cascade"),
    check(
      "collaboration_proposal_anchors_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.baseHeadSeq}) = 'integer'
        and ${table.baseHeadSeq} between 0 and 9007199254740991`,
    ),
    check(
      "collaboration_proposal_anchors_schema_fingerprint_check",
      sql`typeof(${table.schemaFingerprint}) = 'text'
        and length(${table.schemaFingerprint}) = 64
        and ${table.schemaFingerprint} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_proposal_anchors_target_hash_check",
      sql`typeof(${table.targetHash}) = 'text'
        and length(${table.targetHash}) = 64
        and ${table.targetHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_proposal_anchors_association_check",
      sql`${table.startAssoc} = -1 and ${table.endAssoc} = 1`,
    ),
    check(
      "collaboration_proposal_anchors_state_vector_check",
      sql`typeof(${table.baseStateVector}) = 'blob'
        and length(${table.baseStateVector}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.stateVectorBytes}`,
    ),
    check(
      "collaboration_proposal_anchors_relative_positions_check",
      sql`typeof(${table.startRelative}) = 'blob'
        and length(${table.startRelative}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.relativePositionBytes}
        and typeof(${table.endRelative}) = 'blob'
        and length(${table.endRelative}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.relativePositionBytes}`,
    ),
    check(
      "collaboration_proposal_anchors_target_preview_check",
      sql`typeof(${table.targetPreview}) = 'text'
        and length(cast(${table.targetPreview} as blob)) between 0 and ${COLLABORATION_STORAGE_LIMIT_SQL.targetPreviewBytes}`,
    ),
  ],
);

export const collaborationDocumentChanges = sqliteTable(
  "collaboration_document_changes",
  {
    workspaceId: text("workspace_id").notNull(),
    changeId: text("change_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    actionId: text("action_id").notNull(),
    forwardSeq: integer("forward_seq").notNull(),
    inverseUpdate: blob("inverse_update", { mode: "buffer" }).notNull(),
    affectedStartRelative: blob("affected_start_relative", { mode: "buffer" }).notNull(),
    affectedEndRelative: blob("affected_end_relative", { mode: "buffer" }).notNull(),
    postconditionFingerprint: text("postcondition_fingerprint").notNull(),
    baseHeadSeq: integer("base_head_seq").notNull(),
    resultingHeadSeq: integer("resulting_head_seq").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.changeId],
      name: "collaboration_document_changes_pk",
    }),
    uniqueIndex("collaboration_document_changes_workspace_action_unique").on(
      table.workspaceId,
      table.actionId,
    ),
    index("collaboration_document_changes_document_generation_history_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.resultingHeadSeq,
      table.changeId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_document_changes_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.changeId, table.documentId],
      foreignColumns: [documentChanges.workspaceId, documentChanges.id, documentChanges.documentId],
      name: "collaboration_document_changes_change_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.actionId, table.documentId, table.generation],
      foreignColumns: [
        collaborationActions.workspaceId,
        collaborationActions.id,
        collaborationActions.documentId,
        collaborationActions.generation,
      ],
      name: "collaboration_document_changes_action_fk",
    }),
    check(
      "collaboration_document_changes_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.baseHeadSeq}) = 'integer' and ${table.baseHeadSeq} between 0 and 9007199254740991
        and typeof(${table.forwardSeq}) = 'integer' and ${table.forwardSeq} between 1 and 9007199254740991
        and typeof(${table.resultingHeadSeq}) = 'integer'
        and ${table.resultingHeadSeq} between 1 and 9007199254740991
        and ${table.forwardSeq} > ${table.baseHeadSeq}
        and ${table.resultingHeadSeq} >= ${table.forwardSeq}`,
    ),
    check(
      "collaboration_document_changes_postcondition_check",
      sql`typeof(${table.postconditionFingerprint}) = 'text'
        and length(${table.postconditionFingerprint}) = 64
        and ${table.postconditionFingerprint} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_document_changes_inverse_update_check",
      sql`typeof(${table.inverseUpdate}) = 'blob'
        and length(${table.inverseUpdate}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.codecBytes}`,
    ),
    check(
      "collaboration_document_changes_relative_positions_check",
      sql`typeof(${table.affectedStartRelative}) = 'blob'
        and length(${table.affectedStartRelative}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.relativePositionBytes}
        and typeof(${table.affectedEndRelative}) = 'blob'
        and length(${table.affectedEndRelative}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.relativePositionBytes}`,
    ),
  ],
);

export const collaborationAiRunSnapshots = sqliteTable(
  "collaboration_ai_run_snapshots",
  {
    workspaceId: text("workspace_id").notNull(),
    aiRunId: text("ai_run_id").notNull(),
    documentId: text("document_id").notNull(),
    generation: integer("generation").notNull(),
    headSeq: integer("head_seq").notNull(),
    stateVector: blob("state_vector", { mode: "buffer" }).notNull(),
    schemaFingerprint: text("schema_fingerprint").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.aiRunId],
      name: "collaboration_ai_run_snapshots_pk",
    }),
    index("collaboration_ai_run_snapshots_document_generation_history_idx").on(
      table.workspaceId,
      table.documentId,
      table.generation,
      table.createdAt,
      table.aiRunId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.documentId, table.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.documentId,
        collaborationDocuments.generation,
      ],
      name: "collaboration_ai_run_snapshots_document_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.aiRunId, table.documentId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id, aiRuns.documentId],
      name: "collaboration_ai_run_snapshots_ai_run_fk",
    }).onDelete("cascade"),
    check(
      "collaboration_ai_run_snapshots_sequence_check",
      sql`typeof(${table.generation}) = 'integer' and ${table.generation} between 1 and 9007199254740991
        and typeof(${table.headSeq}) = 'integer' and ${table.headSeq} between 0 and 9007199254740991`,
    ),
    check(
      "collaboration_ai_run_snapshots_schema_fingerprint_check",
      sql`typeof(${table.schemaFingerprint}) = 'text'
        and length(${table.schemaFingerprint}) = 64
        and ${table.schemaFingerprint} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_ai_run_snapshots_content_hash_check",
      sql`typeof(${table.contentHash}) = 'text'
        and length(${table.contentHash}) = 64
        and ${table.contentHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "collaboration_ai_run_snapshots_state_vector_check",
      sql`typeof(${table.stateVector}) = 'blob'
        and length(${table.stateVector}) between 1 and ${COLLABORATION_STORAGE_LIMIT_SQL.stateVectorBytes}`,
    ),
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
export type CollaborationDocumentRecord = typeof collaborationDocuments.$inferSelect;
export type NewCollaborationDocumentRecord = typeof collaborationDocuments.$inferInsert;
export type CollaborationUpdateRecord = typeof collaborationUpdates.$inferSelect;
export type NewCollaborationUpdateRecord = typeof collaborationUpdates.$inferInsert;
export type CollaborationNoopReceiptRecord = typeof collaborationNoopReceipts.$inferSelect;
export type NewCollaborationNoopReceiptRecord = typeof collaborationNoopReceipts.$inferInsert;
export type CollaborationActionRecord = typeof collaborationActions.$inferSelect;
export type NewCollaborationActionRecord = typeof collaborationActions.$inferInsert;
export type CollaborationAuthorizationEpochRecord = typeof collaborationAuthorizationEpochs.$inferSelect;
export type DocumentApprovalRecord = typeof documentApprovals.$inferSelect;
export type NewDocumentApprovalRecord = typeof documentApprovals.$inferInsert;
export type CollaborationProposalAnchorRecord = typeof collaborationProposalAnchors.$inferSelect;
export type CollaborationDocumentChangeRecord = typeof collaborationDocumentChanges.$inferSelect;
export type CollaborationAiRunSnapshotRecord = typeof collaborationAiRunSnapshots.$inferSelect;
export type AppSettingsRecord = typeof appSettings.$inferSelect;
export type NewAppSettingsRecord = typeof appSettings.$inferInsert;
export type RequestBudgetBucketRecord = typeof requestBudgetBuckets.$inferSelect;
