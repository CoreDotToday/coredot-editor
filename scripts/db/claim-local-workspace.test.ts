import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimLocalWorkspace, createClaimDatabaseClient } from "./claim-local-workspace";

const tempDirs: string[] = [];
const clients: Client[] = [];
const FULL_WORKSPACE_TABLES = [
  "prompt_templates",
  "documents",
  "request_budget_buckets",
  "collaboration_authorization_epochs",
  "ai_runs",
  "document_changes",
  "collaboration_documents",
  "ai_proposals",
  "ai_workspace_conversations",
  "collaboration_actions",
  "document_approvals",
  "collaboration_ai_run_snapshots",
  "document_change_proposals",
  "ai_workspace_messages",
  "collaboration_updates",
  "collaboration_proposal_anchors",
  "collaboration_document_changes",
  "app_settings",
] as const;
const FULL_SUMMARY_KEYS = [
  "aiProposals",
  "aiRuns",
  "aiWorkspaceConversations",
  "aiWorkspaceMessages",
  "appSettings",
  "collaborationActions",
  "collaborationAiRunSnapshots",
  "collaborationAuthorizationEpochs",
  "collaborationDocumentChanges",
  "collaborationDocuments",
  "collaborationProposalAnchors",
  "collaborationUpdates",
  "documentApprovals",
  "documentChangeProposals",
  "documentChanges",
  "documents",
  "promptTemplates",
  "requestBudgetBuckets",
] as const;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function createClaimDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-claim-workspace-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "claim.db")}` });
  clients.push(client);
  await client.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL,
      UNIQUE(workspace_id, id)
    );
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, builtin_key text,
      UNIQUE(workspace_id, id), UNIQUE(workspace_id, builtin_key)
    );
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, document_id text NOT NULL,
      prompt_template_id text,
      UNIQUE(workspace_id, id, document_id),
      FOREIGN KEY(workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, ai_run_id text NOT NULL,
      document_id text NOT NULL,
      FOREIGN KEY(workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, ai_run_id, document_id)
        REFERENCES ai_runs(workspace_id, id, document_id) ON DELETE CASCADE
    );
    CREATE TABLE app_settings (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL UNIQUE
    );
    CREATE TRIGGER ai_runs_prompt_template_workspace_update
    BEFORE UPDATE OF workspace_id, prompt_template_id ON ai_runs
    FOR EACH ROW WHEN NEW.prompt_template_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM prompt_templates
        WHERE workspace_id = NEW.workspace_id AND id = NEW.prompt_template_id
      ) THEN RAISE(ABORT, 'ai_run prompt template workspace mismatch') END;
    END;
    INSERT INTO documents VALUES ('doc_local', 'local');
    INSERT INTO prompt_templates VALUES ('tpl_local', 'local', 'builtin-review');
    INSERT INTO ai_runs VALUES ('run_local', 'local', 'doc_local', 'tpl_local');
    INSERT INTO ai_proposals VALUES ('proposal_local', 'local', 'run_local', 'doc_local');
    INSERT INTO app_settings VALUES ('settings_local', 'local');
  `);
  return client;
}

async function createMigratedClaimDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-claim-migrated-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "migrated.db")}` });
  clients.push(client);
  const migrations = [
    "0000_amused_serpent_society.sql",
    "0001_violet_bishop.sql",
    "0002_fine_eternity.sql",
    "0003_marvelous_mac_gargan.sql",
    "0004_typical_puma.sql",
    "0005_tiny_slyde.sql",
    "0006_workspace_ownership.sql",
  ];
  for (const migrationName of migrations) {
    const migration = await readFile(resolve(process.cwd(), "drizzle", migrationName), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.execute(statement);
    }
  }
  await client.executeMultiple(`
    INSERT INTO documents (
      id, workspace_id, title, content_json, plain_text, status, readiness,
      metadata_json, created_at, updated_at
    ) VALUES ('migrated_doc', 'local', 'Migrated', '{"type":"doc"}', '', 'draft', 'draft', '{}', 1, 1);
    INSERT INTO prompt_templates (
      id, workspace_id, builtin_key, name, description, category, system_prompt,
      variable_schema_json, is_default, is_active, created_at, updated_at
    ) VALUES ('migrated_tpl', 'local', 'migrated-builtin', 'Migrated', 'Migrated', 'review', 'Review.',
      '{"fields":[],"required":[]}', 1, 1, 1, 1);
    INSERT INTO ai_runs (
      id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
      input_summary_json, output_text, status, was_applied, created_at, updated_at
    ) VALUES ('migrated_run', 'local', 'migrated_doc', 'migrated_tpl', 'document_review', 'stub',
      'stub-editor', '{}', '', 'completed', 0, 1, 1);
    INSERT INTO ai_proposals (
      id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
      source, default_apply_mode, status, created_at, updated_at
    ) VALUES ('migrated_proposal', 'local', 'migrated_run', 'migrated_doc', 'a', 'b', 'c',
      'review', 'replace', 'pending', 1, 1);
    INSERT INTO app_settings (
      id, workspace_id, ai_provider, ai_model, created_at, updated_at
    ) VALUES ('migrated_settings', 'local', 'stub', 'stub-editor', 1, 1);
  `);
  return client;
}

async function createFullClaimDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-claim-full-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "full.db")}` });
  clients.push(client);
  await migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.executeMultiple(`
    INSERT INTO documents (
      id, workspace_id, creation_key, title, content_json, plain_text, status, readiness,
      metadata_json, revision, created_at, updated_at
    ) VALUES ('full_doc', 'local', 'full-creation-key', 'Full', '{"type":"doc"}', 'Full',
      'draft', 'ready', '{}', 1, 1000, 1000);
    INSERT INTO prompt_templates (
      id, workspace_id, builtin_key, name, description, category, system_prompt,
      variable_schema_json, is_default, is_active, created_at, updated_at
    ) VALUES ('full_tpl', 'local', 'full-builtin', 'Full', 'Full', 'review', 'Review.',
      '{"fields":[],"required":[]}', 1, 1, 1000, 1000);
    INSERT INTO request_budget_buckets (
      workspace_id, principal_id, policy_id, window_start, request_count, expires_at
    ) VALUES ('local', 'full_principal', 'ai', 1000, 1, 9000);
    INSERT INTO ai_runs (
      id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
      idempotency_key, operation_fingerprint, input_summary_json, output_text, status,
      was_applied, created_at, updated_at
    ) VALUES ('full_run', 'local', 'full_doc', 'full_tpl', 'document_review', 'stub', 'stub',
      'full-run-key', 'full-run-fingerprint', '{}', '', 'completed', 1, 2000, 2000);
    INSERT INTO ai_proposals (
      id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
      source, default_apply_mode, result_ordinal, status, created_at, updated_at
    ) VALUES ('full_proposal', 'local', 'full_run', 'full_doc', 'old', 'new', 'why',
      'review', 'replace', 0, 'accepted', 3000, 3000);
    INSERT INTO document_changes (
      id, workspace_id, document_id, principal_id, request_id, kind, before_snapshot_json,
      after_revision, created_at
    ) VALUES ('full_change', 'local', 'full_doc', 'full_principal', 'full_request', 'single',
      '{"title":"Before","contentJson":{"type":"doc"},"metadataJson":{},"readiness":"ready"}',
      1, 4000);
    INSERT INTO document_change_proposals (
      workspace_id, change_id, document_id, proposal_id, applied_mode, ordinal
    ) VALUES ('local', 'full_change', 'full_doc', 'full_proposal', 'replace', 0);
    INSERT INTO ai_workspace_conversations (
      id, workspace_id, document_id, created_by_principal_id, creation_key,
      creation_fingerprint, title, command, status, version, message_count,
      latest_ai_run_id, latest_proposal_id, created_at, updated_at
    ) VALUES ('full_conversation', 'local', 'full_doc', 'full_principal', 'full-conversation-key',
      'full-conversation-fingerprint', 'Conversation', 'Review', 'idle', 1, 1,
      'full_run', 'full_proposal', 5000, 5000);
    INSERT INTO ai_workspace_messages (
      id, workspace_id, conversation_id, document_id, mutation_key, mutation_fingerprint,
      ordinal, role, content, ai_run_id, proposal_id, created_at
    ) VALUES ('full_message', 'local', 'full_conversation', 'full_doc', 'full-message-key',
      'full-message-fingerprint', 0, 'assistant', 'Answer', 'full_run', 'full_proposal', 5000);
    INSERT INTO collaboration_documents (
      workspace_id, document_id, generation, is_current, schema_version, schema_fingerprint,
      checkpoint_blob, checkpoint_checksum, head_seq, checkpoint_seq, projected_seq,
      last_checkpoint_at, created_at, updated_at
    ) VALUES ('local', 'full_doc', 1, 1, 1, '${HASH_A}', X'0102', '${HASH_B}', 1, 0, 0,
      6000, 6000, 6000);
    INSERT INTO collaboration_actions (
      id, workspace_id, document_id, generation, command_id, action_type, principal_id,
      request_id, base_head_seq, applied_head_seq, proposal_id, document_change_id,
      status, failure_category, created_at, updated_at
    ) VALUES ('full_action', 'local', 'full_doc', 1, 'full-command', 'proposal_apply',
      'full_principal', 'full_request', 0, 1, 'full_proposal', 'full_change',
      'applied', NULL, 6000, 6000);
    INSERT INTO collaboration_updates (
      workspace_id, document_id, generation, seq, update_blob, checksum, idempotency_key,
      origin_kind, principal_id, request_id, session_id, semantic_action_id, diagnostic_json, created_at
    ) VALUES ('local', 'full_doc', 1, 1, X'0304', '${HASH_A}', 'full-update-key',
      'proposal_command', 'full_principal', 'full_request', 'full_session', 'full_action', '{}', 6000);
    INSERT INTO collaboration_authorization_epochs (
      workspace_id, principal_id, epoch, updated_at
    ) VALUES ('local', 'full_principal', 1, 6000);
    INSERT INTO document_approvals (
      id, workspace_id, document_id, generation, approved_head_seq, approved_state_vector,
      approved_content_hash, principal_id, request_id, approved_at,
      invalidated_seq, invalidated_principal_id, invalidated_at
    ) VALUES ('full_approval', 'local', 'full_doc', 1, 1, X'0506', '${HASH_A}',
      'full_principal', 'full_request', 6000, NULL, NULL, NULL);
    INSERT INTO collaboration_proposal_anchors (
      workspace_id, proposal_id, document_id, generation, schema_fingerprint, base_head_seq,
      base_state_vector, start_relative, start_assoc, end_relative, end_assoc,
      target_hash, target_preview, created_at
    ) VALUES ('local', 'full_proposal', 'full_doc', 1, '${HASH_A}', 1, X'0708', X'0910',
      -1, X'1112', 1, '${HASH_B}', 'preview', 6000);
    INSERT INTO collaboration_document_changes (
      workspace_id, change_id, document_id, generation, action_id, forward_seq, inverse_update,
      affected_start_relative, affected_end_relative, postcondition_fingerprint,
      base_head_seq, resulting_head_seq
    ) VALUES ('local', 'full_change', 'full_doc', 1, 'full_action', 1, X'1314', X'1516',
      X'1718', '${HASH_A}', 0, 1);
    INSERT INTO collaboration_ai_run_snapshots (
      workspace_id, ai_run_id, document_id, generation, head_seq, state_vector,
      schema_fingerprint, content_hash, created_at
    ) VALUES ('local', 'full_run', 'full_doc', 1, 1, X'1920', '${HASH_A}', '${HASH_B}', 6000);
    INSERT INTO app_settings (
      id, workspace_id, ai_provider, ai_model, created_at, updated_at
    ) VALUES ('full_settings', 'local', 'stub', 'stub', 1000, 1000);
  `);
  return client;
}

describe("claimLocalWorkspace", () => {
  it("passes hosted libSQL credentials, including the auth token, to the client factory", () => {
    const authToken = "test-token-not-a-secret";
    vi.stubEnv("DATABASE_URL", "libsql://workspace.example.test");
    vi.stubEnv("DATABASE_AUTH_TOKEN", authToken);
    const close = vi.fn();
    const inputs: unknown[] = [];

    const client = createClaimDatabaseClient(((input: unknown) => {
      inputs.push(input);
      return { close } as unknown as Client;
    }) as typeof createClient);

    expect(inputs).toEqual([{
      authToken,
      url: "libsql://workspace.example.test",
    }]);
    expect(close).not.toHaveBeenCalled();
    client.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the transaction and surfaces both failures when rollback rejects", async () => {
    const operationError = new Error("private operation detail");
    const rollbackError = new Error("private rollback detail");
    const close = vi.fn();
    const transaction = {
      close,
      commit: vi.fn(),
      execute: vi.fn().mockRejectedValue(operationError),
      rollback: vi.fn().mockRejectedValue(rollbackError),
    };
    const client = {
      transaction: vi.fn().mockResolvedValue(transaction),
    } as unknown as Pick<Client, "transaction">;

    const error = await claimLocalWorkspace(client, "workspace-acme").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      errors: [operationError, rollbackError],
      message: "Workspace claim failed and rollback could not be completed",
    });
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("moves the complete current Workspace graph atomically", async () => {
    const client = await createFullClaimDatabase();

    const summary = await claimLocalWorkspace(client, "workspace-full");

    expect(summary).toEqual({
      ...Object.fromEntries(FULL_SUMMARY_KEYS.map((key) => [key, 1])),
      targetWorkspaceId: "workspace-full",
    });
    for (const table of FULL_WORKSPACE_TABLES) {
      expect((await client.execute(`SELECT DISTINCT workspace_id FROM ${table}`)).rows, table).toEqual([
        expect.objectContaining({ workspace_id: "workspace-full" }),
      ]);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("preflights an authorization epoch collision and rolls back the entire graph", async () => {
    const client = await createFullClaimDatabase();
    await client.execute(`
      INSERT INTO collaboration_authorization_epochs (
        workspace_id, principal_id, epoch, updated_at
      ) VALUES ('workspace-full', 'full_principal', 2, 7000)
    `);

    await expect(claimLocalWorkspace(client, "workspace-full")).rejects.toThrow(/authorization epoch.*conflict/i);

    for (const table of FULL_WORKSPACE_TABLES) {
      expect((await client.execute({
        sql: `SELECT count(*) AS count FROM ${table} WHERE workspace_id = 'local'`,
        args: [],
      })).rows[0]?.count, table).toBe(1);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("refuses a partial collaboration schema instead of moving only the visible subset", async () => {
    const client = await createClaimDatabase();
    await client.executeMultiple(`
      CREATE TABLE collaboration_documents (
        workspace_id text NOT NULL,
        document_id text NOT NULL,
        PRIMARY KEY (workspace_id, document_id)
      );
      INSERT INTO collaboration_documents VALUES ('local', 'doc_local');
    `);

    await expect(claimLocalWorkspace(client, "workspace-acme")).rejects.toThrow(/complete.*collaboration.*schema/i);

    expect((await client.execute("SELECT workspace_id FROM documents WHERE id = 'doc_local'")).rows[0]?.workspace_id)
      .toBe("local");
    expect((await client.execute("SELECT workspace_id FROM collaboration_documents")).rows[0]?.workspace_id)
      .toBe("local");
  });

  it.each([
    {
      label: "document creation key",
      prepare: (client: Client) => client.execute(`
        INSERT INTO documents (
          id, workspace_id, creation_key, title, content_json, plain_text, status, readiness,
          metadata_json, revision, created_at, updated_at
        ) VALUES ('target-doc', 'workspace-full', 'full-creation-key', 'Target', '{"type":"doc"}', '',
          'draft', 'draft', '{}', 0, 1, 1)
      `),
    },
    {
      label: "AI idempotency key",
      prepare: async (client: Client) => {
        await client.execute(`
          INSERT INTO documents (
            id, workspace_id, title, content_json, plain_text, status, readiness,
            metadata_json, revision, created_at, updated_at
          ) VALUES ('target-ai-doc', 'workspace-full', 'Target', '{"type":"doc"}', '',
            'draft', 'draft', '{}', 0, 1, 1)
        `);
        await client.execute(`
          INSERT INTO ai_runs (
            id, workspace_id, document_id, command_type, provider, model, idempotency_key,
            operation_fingerprint, input_summary_json, output_text, status, was_applied, created_at, updated_at
          ) VALUES ('target-run', 'workspace-full', 'target-ai-doc', 'document_review', 'stub', 'stub',
            'full-run-key', 'target-fingerprint', '{}', '', 'completed', 0, 1, 1)
        `);
      },
    },
    {
      label: "conversation creation key",
      prepare: async (client: Client) => {
        await client.execute(`
          INSERT INTO documents (
            id, workspace_id, title, content_json, plain_text, status, readiness,
            metadata_json, revision, created_at, updated_at
          ) VALUES ('target-conversation-doc', 'workspace-full', 'Target', '{"type":"doc"}', '',
            'draft', 'draft', '{}', 0, 1, 1)
        `);
        await client.execute(`
          INSERT INTO ai_workspace_conversations (
            id, workspace_id, document_id, created_by_principal_id, creation_key,
            creation_fingerprint, title, command, status, version, message_count,
            created_at, updated_at
          ) VALUES ('target-conversation', 'workspace-full', 'target-conversation-doc', 'target-principal',
            'full-conversation-key', 'target-fingerprint', 'Target', 'Review', 'idle', 1, 1, 1, 1)
        `);
      },
    },
    {
      label: "request budget",
      prepare: (client: Client) => client.execute(`
        INSERT INTO request_budget_buckets (
          workspace_id, principal_id, policy_id, window_start, request_count, expires_at
        ) VALUES ('workspace-full', 'full_principal', 'ai', 1000, 2, 9000)
      `),
    },
    {
      label: "collaboration action command",
      prepare: async (client: Client) => {
        await client.execute(`
          INSERT INTO documents (
            id, workspace_id, title, content_json, plain_text, status, readiness,
            metadata_json, revision, created_at, updated_at
          ) VALUES ('target-action-doc', 'workspace-full', 'Target', '{"type":"doc"}', '',
            'draft', 'draft', '{}', 0, 1, 1)
        `);
        await client.execute(`
          INSERT INTO collaboration_documents (
            workspace_id, document_id, generation, is_current, schema_version, schema_fingerprint,
            checkpoint_blob, checkpoint_checksum, head_seq, checkpoint_seq, projected_seq,
            last_checkpoint_at, created_at, updated_at
          ) VALUES ('workspace-full', 'target-action-doc', 1, 1, 1, '${HASH_A}', X'0102',
            '${HASH_B}', 0, 0, 0, 1, 1, 1)
        `);
        await client.execute(`
          INSERT INTO collaboration_actions (
            id, workspace_id, document_id, generation, command_id, action_type, principal_id,
            request_id, base_head_seq, applied_head_seq, status, failure_category, created_at, updated_at
          ) VALUES ('target-action', 'workspace-full', 'target-action-doc', 1, 'full-command', 'repair',
            'target-principal', 'target-request', 0, NULL, 'pending', NULL, 1, 1)
        `);
      },
    },
  ])("preflights $label conflicts without moving local rows", async ({ label, prepare }) => {
    const client = await createFullClaimDatabase();
    await prepare(client);

    await expect(claimLocalWorkspace(client, "workspace-full")).rejects.toThrow(new RegExp(`${label}.*conflict`, "i"));

    expect((await client.execute("SELECT workspace_id FROM documents WHERE id = 'full_doc'")).rows[0]?.workspace_id)
      .toBe("local");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("claims all five row types after applying the exact 0000-0006 migration chain", async () => {
    const client = await createMigratedClaimDatabase();

    const summary = await claimLocalWorkspace(client, "workspace-migrated");

    expect(summary).toMatchObject({
      aiProposals: 1,
      aiRuns: 1,
      appSettings: 1,
      documents: 1,
      promptTemplates: 1,
    });
    for (const table of ["documents", "prompt_templates", "ai_runs", "ai_proposals", "app_settings"]) {
      expect((await client.execute(`SELECT DISTINCT workspace_id FROM ${table}`)).rows).toEqual([
        expect.objectContaining({ workspace_id: "workspace-migrated" }),
      ]);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("rolls back an exact migrated database when the target has a built-in conflict", async () => {
    const client = await createMigratedClaimDatabase();
    await client.execute(`
      INSERT INTO prompt_templates (
        id, workspace_id, builtin_key, name, description, category, system_prompt,
        variable_schema_json, is_default, is_active, created_at, updated_at
      ) VALUES ('target_tpl', 'workspace-migrated', 'migrated-builtin', 'Target', 'Target', 'review', 'Review.',
        '{"fields":[],"required":[]}', 1, 1, 1, 1)
    `);

    await expect(claimLocalWorkspace(client, "workspace-migrated")).rejects.toThrow(/migrated-builtin.*conflict/i);

    for (const table of ["documents", "ai_runs", "ai_proposals", "app_settings"]) {
      expect((await client.execute(`SELECT workspace_id FROM ${table} WHERE workspace_id = 'local'`)).rows).toHaveLength(1);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("moves every legacy row atomically and leaves foreign keys clean", async () => {
    const client = await createClaimDatabase();

    const summary = await claimLocalWorkspace(client, " workspace-acme ");

    expect(summary).toEqual({
      ...Object.fromEntries(FULL_SUMMARY_KEYS.map((key) => [key, 0])),
      aiProposals: 1,
      aiRuns: 1,
      appSettings: 1,
      documents: 1,
      promptTemplates: 1,
      targetWorkspaceId: "workspace-acme",
    });
    for (const table of ["documents", "prompt_templates", "ai_runs", "ai_proposals", "app_settings"]) {
      expect((await client.execute(`SELECT workspace_id FROM ${table}`)).rows).toEqual([
        expect.objectContaining({ workspace_id: "workspace-acme" }),
      ]);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("is a no-op when there are no local rows", async () => {
    const client = await createClaimDatabase();
    await claimLocalWorkspace(client, "workspace-acme");

    await expect(claimLocalWorkspace(client, "workspace-other")).resolves.toMatchObject({
      aiProposals: 0,
      aiRuns: 0,
      appSettings: 0,
      documents: 0,
      promptTemplates: 0,
    });
  });

  it.each(["", "   ", "local", " local "])("rejects invalid target %j", async (target) => {
    const client = await createClaimDatabase();
    await expect(claimLocalWorkspace(client, target)).rejects.toThrow(/non-empty|reserved/i);
    expect((await client.execute("SELECT DISTINCT workspace_id FROM documents")).rows[0]?.workspace_id).toBe("local");
  });

  it("rolls back without partial movement when target builtins conflict", async () => {
    const client = await createClaimDatabase();
    await client.execute("INSERT INTO prompt_templates VALUES ('target_tpl', 'workspace-acme', 'builtin-review')");

    await expect(claimLocalWorkspace(client, "workspace-acme")).rejects.toThrow(/builtin-review.*conflict/i);

    expect((await client.execute("SELECT workspace_id FROM documents WHERE id='doc_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("SELECT workspace_id FROM ai_runs WHERE id='run_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("rolls back when the target already has settings", async () => {
    const client = await createClaimDatabase();
    await client.execute("INSERT INTO app_settings VALUES ('target_settings', 'workspace-acme')");

    await expect(claimLocalWorkspace(client, "workspace-acme")).rejects.toThrow(/settings.*conflict/i);
    expect((await client.execute("SELECT workspace_id FROM app_settings WHERE id='settings_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("SELECT workspace_id FROM documents WHERE id='doc_local'")).rows[0]?.workspace_id).toBe("local");
  });

  it("supports a dry run that reports counts without mutation", async () => {
    const client = await createClaimDatabase();
    const summary = await claimLocalWorkspace(client, "workspace-acme", { dryRun: true });

    expect(summary.documents).toBe(1);
    expect((await client.execute("SELECT workspace_id FROM documents")).rows[0]?.workspace_id).toBe("local");
  });
});
