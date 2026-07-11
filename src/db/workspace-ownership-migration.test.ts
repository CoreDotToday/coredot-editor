import { createClient } from "@libsql/client";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createLegacyDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-workspace-migration-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "legacy.db")}` });

  await client.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      readiness text DEFAULT 'draft' NOT NULL,
      metadata_json text DEFAULT '{}' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      description text NOT NULL,
      category text NOT NULL,
      system_prompt text NOT NULL,
      variable_schema_json text NOT NULL,
      is_default integer DEFAULT false NOT NULL,
      is_active integer DEFAULT true NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL,
      document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      prompt_template_id text REFERENCES prompt_templates(id) ON DELETE SET NULL,
      command_type text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      input_summary_json text NOT NULL,
      output_text text DEFAULT '' NOT NULL,
      status text NOT NULL,
      was_applied integer DEFAULT false NOT NULL,
      error_message text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL,
      ai_run_id text NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
      document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      target_text text NOT NULL,
      replacement_text text NOT NULL,
      explanation text NOT NULL,
      source text DEFAULT 'review' NOT NULL,
      command text,
      occurrence_index integer,
      target_from integer,
      target_to integer,
      default_apply_mode text DEFAULT 'replace' NOT NULL,
      applied_mode text,
      status text DEFAULT 'pending' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE app_settings (
      id text PRIMARY KEY NOT NULL,
      ai_provider text DEFAULT 'stub' NOT NULL,
      ai_model text DEFAULT 'stub-editor' NOT NULL,
      ai_base_url text,
      ai_max_completion_tokens integer,
      ai_reasoning_effort text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    INSERT INTO documents VALUES
      ('legacy_doc', 'Legacy memo', '{"type":"doc"}', 'Legacy body', 'draft', 'ready', '{}', 1000, 2000);
    INSERT INTO prompt_templates VALUES
      ('tpl_strategy_review', 'Strategy Review', 'Legacy default', 'strategy_review', 'Review.', '{"fields":[],"required":[]}', 1, 1, 1000, 2000);
    INSERT INTO ai_runs VALUES
      ('legacy_run', 'legacy_doc', 'tpl_strategy_review', 'document_review', 'stub', 'stub-editor', '{}', 'Output', 'completed', 0, NULL, 1000, 2000);
    INSERT INTO ai_proposals VALUES
      ('legacy_proposal', 'legacy_run', 'legacy_doc', 'Legacy', 'Current', 'Clearer.', 'review', NULL, 0, NULL, NULL, 'replace', NULL, 'pending', 1000, 2000);
    INSERT INTO app_settings VALUES
      ('default', 'stub', 'stub-editor', NULL, NULL, NULL, 1000, 2000);
  `);

  return client;
}

async function applyWorkspaceOwnershipMigration(client: Awaited<ReturnType<typeof createLegacyDatabase>>) {
  const migration = await readFile(resolve(process.cwd(), "drizzle/0006_workspace_ownership.sql"), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) {
      await client.execute(sql);
    }
  }
}

async function applyRequestBudgetMigration(client: Awaited<ReturnType<typeof createLegacyDatabase>>) {
  const migration = await readFile(resolve(process.cwd(), "drizzle/0007_request_budgets.sql"), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await client.execute(sql);
  }
}

describe("workspace ownership migration", () => {
  it("applies request budgets on a populated 0006 database without disturbing data or foreign keys", async () => {
    const client = await createLegacyDatabase();
    await applyWorkspaceOwnershipMigration(client);
    await applyRequestBudgetMigration(client);

    expect((await client.execute("SELECT title FROM documents WHERE id = 'legacy_doc'")).rows[0]?.title).toBe("Legacy memo");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    await expect(
      client.execute(`
        INSERT INTO request_budget_buckets
          (workspace_id, principal_id, policy_id, window_start, request_count, expires_at)
        VALUES ('local', 'principal', 'test', 0, 1, 60000)
      `),
    ).resolves.toBeDefined();
  });

  it("backfills stable built-in identity for migrated defaults", async () => {
    const client = await createLegacyDatabase();
    await applyWorkspaceOwnershipMigration(client);

    const ownership = await client.execute(`
      SELECT workspace_id, builtin_key
      FROM prompt_templates
      WHERE id = 'tpl_strategy_review'
    `);
    expect(ownership.rows).toEqual([
      expect.objectContaining({ builtin_key: "tpl_strategy_review", workspace_id: "local" }),
    ]);
  });

  it("enforces relational ownership with preserved delete behavior", async () => {
    const client = await createLegacyDatabase();
    await applyWorkspaceOwnershipMigration(client);

    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);

    await client.execute(`
      INSERT INTO documents (
        id, workspace_id, title, content_json, plain_text, status, readiness,
        metadata_json, created_at, updated_at
      ) VALUES (
        'workspace_b_doc', 'workspace_b', 'Workspace B', '{"type":"doc"}', '', 'draft',
        'draft', '{}', 3000, 3000
      )
    `);

    await expect(
      client.execute(`
        INSERT INTO ai_runs (
          id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
          input_summary_json, output_text, status, was_applied, created_at, updated_at
        ) VALUES (
          'cross_template_run', 'workspace_b', 'workspace_b_doc', 'tpl_strategy_review', 'document_review', 'stub',
          'stub-editor', '{}', '', 'pending', 0, 3000, 3000
        )
      `),
    ).rejects.toThrow();
    await expect(
      client.execute(`
        INSERT INTO ai_runs (
          id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
          input_summary_json, output_text, status, was_applied, created_at, updated_at
        ) VALUES (
          'cross_document_run', 'workspace_b', 'legacy_doc', NULL, 'document_review', 'stub',
          'stub-editor', '{}', '', 'pending', 0, 3000, 3000
        )
      `),
    ).rejects.toThrow();
    await client.execute(`
      INSERT INTO ai_runs (
        id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
        input_summary_json, output_text, status, was_applied, created_at, updated_at
      ) VALUES (
        'local_run', 'local', 'legacy_doc', 'tpl_strategy_review', 'document_review', 'stub',
        'stub-editor', '{}', '', 'pending', 0, 3000, 3000
      )
    `);
    await client.execute(`
      INSERT INTO prompt_templates (
        id, workspace_id, builtin_key, name, description, category, system_prompt,
        variable_schema_json, is_default, is_active, created_at, updated_at
      ) VALUES (
        'workspace_b_template', 'workspace_b', NULL, 'Workspace B Template', 'Private', 'review',
        'Review.', '{"fields":[],"required":[]}', 0, 1, 3000, 3000
      )
    `);
    await expect(
      client.execute(`
        UPDATE ai_runs
        SET prompt_template_id = 'workspace_b_template'
        WHERE id = 'local_run'
      `),
    ).rejects.toThrow();

    await expect(
      client.execute(`
        INSERT INTO ai_proposals (
          id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
          source, default_apply_mode, status, created_at, updated_at
        ) VALUES (
          'cross_proposal', 'workspace_b', 'legacy_run', 'legacy_doc', 'Legacy', 'Current',
          'Cross workspace', 'review', 'replace', 'pending', 3000, 3000
        )
      `),
    ).rejects.toThrow();

    await client.execute("DELETE FROM prompt_templates WHERE id = 'tpl_strategy_review'");
    const runsAfterTemplateDelete = await client.execute(
      "SELECT workspace_id, prompt_template_id FROM ai_runs WHERE document_id = 'legacy_doc' ORDER BY id",
    );
    expect(runsAfterTemplateDelete.rows.every((row) => row.prompt_template_id === null)).toBe(true);
    expect(runsAfterTemplateDelete.rows.every((row) => row.workspace_id === "local")).toBe(true);

    await client.execute("DELETE FROM documents WHERE id = 'legacy_doc'");
    expect((await client.execute("SELECT count(*) AS count FROM ai_runs")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT count(*) AS count FROM ai_proposals")).rows[0]?.count).toBe(0);
  });
});
