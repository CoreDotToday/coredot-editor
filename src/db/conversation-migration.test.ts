import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("conversation migration", () => {
  it("applies the complete fresh migration chain with scoped links and document cascade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-conversation-migration-"));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${join(dir, "fresh.db")}` });
    await migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), "drizzle") });

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

    await client.execute("DELETE FROM documents WHERE workspace_id = 'workspace-a' AND id = 'doc-a'");
    expect((await client.execute("SELECT id FROM ai_workspace_conversations")).rows).toEqual([]);
    expect((await client.execute("SELECT id FROM ai_workspace_messages")).rows).toEqual([]);
  });
});
