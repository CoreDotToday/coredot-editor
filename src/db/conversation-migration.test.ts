import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const migrationsFolder = resolve(process.cwd(), "drizzle");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("conversation migration", () => {
  it("applies the complete fresh migration chain with scoped links and document cascade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-conversation-migration-"));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${join(dir, "fresh.db")}` });
    await migrate(drizzle(client), { migrationsFolder });

    await client.execute(`
      INSERT INTO documents (
        id, workspace_id, title, content_json, plain_text, status, readiness,
        metadata_json, revision, created_at, updated_at
      ) VALUES
        ('doc-a', 'workspace-a', 'A', '{"type":"doc"}', '', 'draft', 'draft', '{}', 0, 1000, 1000),
        ('doc-b', 'workspace-b', 'B', '{"type":"doc"}', '', 'draft', 'draft', '{}', 0, 1000, 1000)
    `);
    await client.execute(`
      INSERT INTO ai_runs (
        id, workspace_id, document_id, command_type, provider, model, input_summary_json,
        output_text, status, was_applied, created_at, updated_at
      ) VALUES
        ('run-a', 'workspace-a', 'doc-a', 'selection_rewrite', 'stub', 'stub', '{}', '', 'completed', 0, 1000, 1000),
        ('run-b', 'workspace-b', 'doc-b', 'selection_rewrite', 'stub', 'stub', '{}', '', 'completed', 0, 1000, 1000)
    `);
    await client.execute(`
      INSERT INTO ai_proposals (
        id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
        source, default_apply_mode, status, created_at, updated_at
      ) VALUES
        ('proposal-a', 'workspace-a', 'run-a', 'doc-a', 'a', 'b', 'c', 'selection', 'replace', 'pending', 1000, 1000),
        ('proposal-b', 'workspace-b', 'run-b', 'doc-b', 'a', 'b', 'c', 'selection', 'replace', 'pending', 1000, 1000)
    `);
    await client.execute(`
      INSERT INTO ai_workspace_conversations (
        id, workspace_id, document_id, created_by_principal_id, creation_key,
        creation_fingerprint, title, command, status, version, message_count,
        latest_ai_run_id, latest_proposal_id, created_at, updated_at
      ) VALUES (
        'conversation-a', 'workspace-a', 'doc-a', 'principal-a', 'creation-key-a-0001',
        'fingerprint-a', 'Conversation', 'Rewrite', 'idle', 1, 1,
        'run-a', 'proposal-a', 1000, 1000
      )
    `);
    await client.execute(`
      INSERT INTO ai_workspace_messages (
        id, workspace_id, conversation_id, document_id, mutation_key,
        mutation_fingerprint, ordinal, role, content, ai_run_id, proposal_id, created_at
      ) VALUES (
        'message-a', 'workspace-a', 'conversation-a', 'doc-a', 'mutation-key-a-0001',
        'message-fingerprint-a', 0, 'assistant', 'Answer', 'run-a', 'proposal-a', 1000
      )
    `);

    await expect(client.execute(`
      INSERT INTO ai_workspace_messages (
        id, workspace_id, conversation_id, document_id, mutation_key,
        mutation_fingerprint, ordinal, role, content, ai_run_id, created_at
      ) VALUES (
        'cross-run', 'workspace-a', 'conversation-a', 'doc-a', 'mutation-key-cross-run',
        'message-fingerprint-b', 1, 'assistant', 'No', 'run-b', 1000
      )
    `)).rejects.toThrow();
    await expect(client.execute(`
      INSERT INTO ai_workspace_messages (
        id, workspace_id, conversation_id, document_id, mutation_key,
        mutation_fingerprint, ordinal, role, content, proposal_id, created_at
      ) VALUES (
        'cross-proposal', 'workspace-a', 'conversation-a', 'doc-a', 'mutation-key-cross-proposal',
        'message-fingerprint-c', 1, 'assistant', 'No', 'proposal-b', 1000
      )
    `)).rejects.toThrow();
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    expect((await client.execute(
      "PRAGMA index_info('ai_workspace_conversations_workspace_document_updated_idx')",
    )).rows.map((row) => row.name)).toEqual([
      "workspace_id",
      "document_id",
      "archived_at",
      "updated_at",
      "id",
    ]);
    for (const [indexName, expectedColumns] of [
      ["documents_workspace_status_updated_id_idx", ["workspace_id", "status", "updated_at", "id"]],
      ["ai_runs_workspace_document_created_id_idx", ["workspace_id", "document_id", "created_at", "id"]],
      ["ai_proposals_workspace_document_created_id_idx", ["workspace_id", "document_id", "created_at", "id"]],
    ] as const) {
      expect((await client.execute(`PRAGMA index_info('${indexName}')`)).rows.map((row) => row.name))
        .toEqual(expectedColumns);
    }
    for (const indexName of [
      "documents_workspace_status_updated_idx",
      "ai_runs_workspace_document_created_idx",
      "ai_proposals_workspace_document_created_idx",
    ]) {
      expect((await client.execute(`PRAGMA index_info('${indexName}')`)).rows).toEqual([]);
    }

    await client.execute("DELETE FROM documents WHERE workspace_id = 'workspace-a' AND id = 'doc-a'");
    expect((await client.execute("SELECT id FROM ai_workspace_conversations")).rows).toEqual([]);
    expect((await client.execute("SELECT id FROM ai_workspace_messages")).rows).toEqual([]);
  });

  it("upgrades populated pre-0014 data without losing rows, foreign keys, or cursor indexes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-0014-upgrade-"));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${join(dir, "upgrade.db")}` });
    const database = drizzle(client);
    const pre0014Folder = await createMigrationPrefix(dir, 13);
    await migrate(database, { migrationsFolder: pre0014Folder });

    await client.execute(`
      INSERT INTO documents (
        id, workspace_id, title, content_json, plain_text, status, readiness,
        metadata_json, revision, created_at, updated_at
      ) VALUES ('doc-upgrade', 'workspace-upgrade', 'Upgrade', '{"type":"doc"}', '', 'draft', 'draft', '{}', 0, 1000, 2000)
    `);
    await client.execute(`
      INSERT INTO ai_runs (
        id, workspace_id, document_id, command_type, provider, model, input_summary_json,
        output_text, status, was_applied, created_at, updated_at
      ) VALUES (
        'run-upgrade', 'workspace-upgrade', 'doc-upgrade', 'document_review', 'stub', 'stub', '{}',
        '', 'completed', 0, 3000, 3000
      )
    `);
    await client.execute(`
      INSERT INTO ai_proposals (
        id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
        source, default_apply_mode, status, created_at, updated_at
      ) VALUES (
        'proposal-upgrade', 'workspace-upgrade', 'run-upgrade', 'doc-upgrade', 'old', 'new', 'why',
        'review', 'replace', 'pending', 4000, 4000
      )
    `);
    await client.execute(`
      INSERT INTO ai_workspace_conversations (
        id, workspace_id, document_id, created_by_principal_id, creation_key,
        creation_fingerprint, title, command, status, version, message_count,
        latest_ai_run_id, latest_proposal_id, created_at, updated_at
      ) VALUES (
        'conversation-upgrade', 'workspace-upgrade', 'doc-upgrade', 'principal-upgrade',
        'creation-key-upgrade-0001', 'creation-fingerprint-upgrade', 'Upgrade conversation',
        'Review', 'idle', 1, 1, 'run-upgrade', 'proposal-upgrade', 5000, 5000
      )
    `);
    await client.execute(`
      INSERT INTO ai_workspace_messages (
        id, workspace_id, conversation_id, document_id, mutation_key,
        mutation_fingerprint, ordinal, role, content, ai_run_id, proposal_id, created_at
      ) VALUES (
        'message-upgrade', 'workspace-upgrade', 'conversation-upgrade', 'doc-upgrade',
        'mutation-key-upgrade-0001', 'mutation-fingerprint-upgrade', 0, 'assistant', 'Answer',
        'run-upgrade', 'proposal-upgrade', 5000
      )
    `);

    expect((await client.execute("PRAGMA index_info('documents_workspace_status_updated_idx')")).rows)
      .not.toEqual([]);
    expect((await client.execute("PRAGMA index_info('documents_workspace_status_updated_id_idx')")).rows)
      .toEqual([]);

    await migrate(database, { migrationsFolder });

    for (const [table, id] of [
      ["documents", "doc-upgrade"],
      ["ai_runs", "run-upgrade"],
      ["ai_proposals", "proposal-upgrade"],
      ["ai_workspace_conversations", "conversation-upgrade"],
      ["ai_workspace_messages", "message-upgrade"],
    ] as const) {
      expect((await client.execute({ sql: `SELECT id FROM ${table} WHERE id = ?`, args: [id] })).rows)
        .toEqual([{ id }]);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    for (const [indexName, expectedColumns] of [
      ["documents_workspace_status_updated_id_idx", ["workspace_id", "status", "updated_at", "id"]],
      ["ai_runs_workspace_document_created_id_idx", ["workspace_id", "document_id", "created_at", "id"]],
      ["ai_proposals_workspace_document_created_id_idx", ["workspace_id", "document_id", "created_at", "id"]],
    ] as const) {
      expect((await client.execute(`PRAGMA index_info('${indexName}')`)).rows.map((row) => row.name))
        .toEqual(expectedColumns);
    }
    for (const indexName of [
      "documents_workspace_status_updated_idx",
      "ai_runs_workspace_document_created_idx",
      "ai_proposals_workspace_document_created_idx",
    ]) {
      expect((await client.execute(`PRAGMA index_info('${indexName}')`)).rows).toEqual([]);
    }
  });
});

async function createMigrationPrefix(root: string, lastIndex: number) {
  const target = join(root, `migrations-through-${String(lastIndex)}`);
  await mkdir(join(target, "meta"), { recursive: true });
  const migrationFiles = (await readdir(migrationsFolder))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number.parseInt(name.slice(0, 4), 10) <= lastIndex);
  await Promise.all(migrationFiles.map((name) => copyFile(join(migrationsFolder, name), join(target, name))));

  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }>; [key: string]: unknown };
  await writeFile(
    join(target, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= lastIndex) }, null, 2)}\n`,
    "utf8",
  );
  return target;
}
