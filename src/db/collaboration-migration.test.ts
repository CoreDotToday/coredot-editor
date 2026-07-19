import { createClient, type Client } from "@libsql/client";
import { getTableName, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getTableConfig, SQLiteSyncDialect, type AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collaborationActions,
  collaborationAiRunSnapshots,
  collaborationAuthorizationEpochs,
  collaborationDocumentChanges,
  collaborationDocuments,
  collaborationProposalAnchors,
  collaborationUpdates,
  documentApprovals,
} from "./schema";

const COLLABORATION_TABLES = [
  "collaboration_documents",
  "collaboration_updates",
  "collaboration_actions",
  "collaboration_authorization_epochs",
  "document_approvals",
  "collaboration_proposal_anchors",
  "collaboration_document_changes",
  "collaboration_ai_run_snapshots",
] as const;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const CODEC_BYTES = 10 * 1024 * 1024;
const STATE_VECTOR_BYTES = 1024 * 1024;
const RELATIVE_POSITION_BYTES = 64 * 1024;
const DIAGNOSTIC_JSON_BYTES = 4 * 1024;
const TARGET_PREVIEW_BYTES = 1024;
const CORRECTNESS_KEY_BYTES = 256;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const COLLABORATION_SCHEMA_TABLES = [
  collaborationDocuments,
  collaborationUpdates,
  collaborationActions,
  collaborationAuthorizationEpochs,
  documentApprovals,
  collaborationProposalAnchors,
  collaborationDocumentChanges,
  collaborationAiRunSnapshots,
] as const satisfies readonly AnySQLiteTable[];
const migrationsFolder = resolve(process.cwd(), "drizzle");
const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration migration", () => {
  it("exports all eight collaboration tables from the Drizzle schema", async () => {
    const schema = await import("./schema");

    for (const exportName of [
      "collaborationDocuments",
      "collaborationUpdates",
      "collaborationActions",
      "collaborationAuthorizationEpochs",
      "documentApprovals",
      "collaborationProposalAnchors",
      "collaborationDocumentChanges",
      "collaborationAiRunSnapshots",
    ]) {
      expect(schema[exportName as keyof typeof schema], exportName).toBeDefined();
    }
  });

  it("keeps handwritten collaboration SQL structurally aligned with every Drizzle table", async () => {
    const client = await createDatabase("parity");
    await migrate(drizzle(client), { migrationsFolder });

    for (const table of COLLABORATION_SCHEMA_TABLES) {
      await expectTableParity(client, table);
    }
  });

  it("retains retired generations and permits exactly one current generation", async () => {
    const client = await createDatabase("generations");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedLegacyGraph(client, "generation");
    await insertCollaborationDocument(client, "generation");
    await insertFullCollaborationGraph(client, "generation");

    const columns = await client.execute("PRAGMA table_info(collaboration_documents)");
    expect(columns.rows.map((row) => String(row.name))).toContain("is_current");

    await client.execute(`UPDATE collaboration_documents
      SET is_current = 0
      WHERE workspace_id = 'workspace-generation' AND document_id = 'doc-generation' AND generation = 1`);
    await client.execute(collaborationDocumentInsert("generation", "doc-generation", 2, 1));

    expect((await client.execute(`SELECT generation, is_current
      FROM collaboration_documents
      WHERE workspace_id = 'workspace-generation' AND document_id = 'doc-generation'
      ORDER BY generation`)).rows).toEqual([
      expect.objectContaining({ generation: 1, is_current: 0 }),
      expect.objectContaining({ generation: 2, is_current: 1 }),
    ]);
    expect(await rowCount(client, "collaboration_updates", "workspace-generation")).toBe(1);
    await expectReject(client, collaborationDocumentInsert("generation", "doc-generation", 3, 1));
    await expectReject(client, "UPDATE collaboration_documents SET is_current = 2 WHERE generation = 2");
    await expectReject(client, "UPDATE collaboration_documents SET is_current = 0.5 WHERE generation = 2");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("indexes current generation and every generation-scoped child lookup", async () => {
    const client = await createDatabase("indexes");
    await migrate(drizzle(client), { migrationsFolder });

    await expectIndex(client, "collaboration_documents", {
      columns: ["workspace_id", "document_id"],
      name: "collaboration_documents_current_unique",
      partial: true,
      predicate: "where `is_current` = 1",
      unique: true,
    });
    await expectIndex(client, "collaboration_documents", {
      columns: ["workspace_id", "document_id", "generation"],
      name: "collaboration_documents_workspace_document_generation_idx",
      partial: false,
      unique: false,
    });
    await expectIndex(client, "collaboration_proposal_anchors", {
      columns: ["workspace_id", "document_id", "generation", "created_at", "proposal_id"],
      name: "collaboration_proposal_anchors_document_generation_history_idx",
      partial: false,
      unique: false,
    });
    await expectIndex(client, "collaboration_document_changes", {
      columns: ["workspace_id", "document_id", "generation", "resulting_head_seq", "change_id"],
      name: "collaboration_document_changes_document_generation_history_idx",
      partial: false,
      unique: false,
    });
    await expectIndex(client, "collaboration_ai_run_snapshots", {
      columns: ["workspace_id", "document_id", "generation", "created_at", "ai_run_id"],
      name: "collaboration_ai_run_snapshots_document_generation_history_idx",
      partial: false,
      unique: false,
    });
  });

  it("rejects non-canonical or oversized collaboration storage values", async () => {
    const client = await createDatabase("storage");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedLegacyGraph(client, "a");
    await seedLegacyGraph(client, "b");
    await insertCollaborationDocument(client, "a");
    await insertCollaborationDocument(client, "b");
    await insertFullCollaborationGraph(client, "a");
    await client.execute(collaborationActionInsert({
      command: "failed-command-b",
      document: "doc-b",
      id: "failed-action-b",
      status: "failed",
      workspace: "b",
    }));

    const binaryFields = [
      { column: "checkpoint_blob", maxBytes: CODEC_BYTES, table: "collaboration_documents" },
      { column: "update_blob", maxBytes: CODEC_BYTES, table: "collaboration_updates" },
      { column: "approved_state_vector", maxBytes: STATE_VECTOR_BYTES, table: "document_approvals" },
      { column: "base_state_vector", maxBytes: STATE_VECTOR_BYTES, table: "collaboration_proposal_anchors" },
      { column: "start_relative", maxBytes: RELATIVE_POSITION_BYTES, table: "collaboration_proposal_anchors" },
      { column: "end_relative", maxBytes: RELATIVE_POSITION_BYTES, table: "collaboration_proposal_anchors" },
      { column: "inverse_update", maxBytes: CODEC_BYTES, table: "collaboration_document_changes" },
      { column: "affected_start_relative", maxBytes: RELATIVE_POSITION_BYTES, table: "collaboration_document_changes" },
      { column: "affected_end_relative", maxBytes: RELATIVE_POSITION_BYTES, table: "collaboration_document_changes" },
      { column: "state_vector", maxBytes: STATE_VECTOR_BYTES, table: "collaboration_ai_run_snapshots" },
    ];
    const hashFields = [
      { column: "schema_fingerprint", table: "collaboration_documents" },
      { column: "checkpoint_checksum", table: "collaboration_documents" },
      { column: "checksum", table: "collaboration_updates" },
      { column: "approved_content_hash", table: "document_approvals" },
      { column: "schema_fingerprint", table: "collaboration_proposal_anchors" },
      { column: "target_hash", table: "collaboration_proposal_anchors" },
      { column: "postcondition_fingerprint", table: "collaboration_document_changes" },
      { column: "schema_fingerprint", table: "collaboration_ai_run_snapshots" },
      { column: "content_hash", table: "collaboration_ai_run_snapshots" },
    ];
    const cases = [
      ...binaryFields.flatMap(({ column, maxBytes, table }) => [
        { label: `${table}.${column} text`, statement: `UPDATE ${table} SET ${column} = 'text'` },
        { label: `${table}.${column} empty`, statement: `UPDATE ${table} SET ${column} = X''` },
        {
          label: `${table}.${column} oversized`,
          statement: `UPDATE ${table} SET ${column} = zeroblob(${String(maxBytes + 1)})`,
        },
      ]),
      ...hashFields.map(({ column, table }) => ({
        label: `${table}.${column} blob hash`,
        statement: `UPDATE ${table} SET ${column} = CAST('${HASH_A}' AS BLOB)`,
      })),
      {
        label: "diagnostic_json blob",
        statement: "UPDATE collaboration_updates SET diagnostic_json = CAST('{}' AS BLOB)",
      },
      {
        label: "diagnostic_json array",
        statement: "UPDATE collaboration_updates SET diagnostic_json = '[]'",
      },
      {
        label: "diagnostic_json malformed",
        statement: "UPDATE collaboration_updates SET diagnostic_json = '{'",
      },
      {
        label: "diagnostic_json oversized",
        statement: {
          sql: "UPDATE collaboration_updates SET diagnostic_json = ?",
          args: [JSON.stringify({ value: "x".repeat(DIAGNOSTIC_JSON_BYTES) })],
        },
      },
      {
        label: "target_preview blob",
        statement: "UPDATE collaboration_proposal_anchors SET target_preview = CAST('preview' AS BLOB)",
      },
      {
        label: "target_preview oversized UTF-8",
        statement: {
          sql: "UPDATE collaboration_proposal_anchors SET target_preview = ?",
          args: ["한".repeat(Math.ceil(TARGET_PREVIEW_BYTES / 3) + 1)],
        },
      },
      {
        label: "failure_category blank",
        statement: "UPDATE collaboration_actions SET failure_category = '   ' WHERE id = 'failed-action-b'",
      },
      {
        label: "failure_category blob",
        statement: "UPDATE collaboration_actions SET failure_category = CAST('failure' AS BLOB) WHERE id = 'failed-action-b'",
      },
      {
        label: "failure_category oversized UTF-8",
        statement: {
          sql: "UPDATE collaboration_actions SET failure_category = ? WHERE id = 'failed-action-b'",
          args: ["한".repeat(43)],
        },
      },
      ...correctnessKeyCases("collaboration_actions", "command_id", "id = 'action-a'"),
      ...correctnessKeyCases("collaboration_updates", "idempotency_key", "seq = 1"),
    ];

    await expectAllReject(client, cases);
  });

  it("applies the fresh migration chain with Workspace-safe collaboration constraints", async () => {
    const client = await createDatabase("fresh");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");

    expect(await tableNames(client)).toEqual(expect.arrayContaining([...COLLABORATION_TABLES]));
    await seedLegacyGraph(client, "a");
    await seedLegacyGraph(client, "b");
    await insertCollaborationDocument(client, "a");
    await insertCollaborationDocument(client, "b");
    await insertFullCollaborationGraph(client, "a");

    await expectReject(client, collaborationDocumentInsert("b", "doc-a"));
    await expectReject(client, collaborationUpdateInsert({ workspace: "b", document: "doc-a", seq: 2 }));
    await expectReject(client, collaborationUpdateInsert({ workspace: "a", document: "doc-a", generation: 2, seq: 2 }));
    await expectReject(client, collaborationActionInsert({
      id: "action-wrong-workspace",
      workspace: "b",
      document: "doc-a",
      command: "command-wrong-workspace",
    }));
    await expectReject(client, collaborationActionInsert({
      id: "action-wrong-proposal",
      workspace: "a",
      document: "doc-a",
      command: "command-wrong-proposal",
      proposal: "proposal-b",
    }));
    await expectReject(client, collaborationActionInsert({
      id: "action-wrong-change",
      workspace: "a",
      document: "doc-a",
      command: "command-wrong-change",
      change: "change-b",
    }));
    await expectReject(client, approvalInsert({ id: "approval-wrong", workspace: "b", document: "doc-a" }));
    await expectReject(client, anchorInsert({ workspace: "b", proposal: "proposal-a", document: "doc-a" }));
    await expectReject(client, collaborationChangeInsert({
      workspace: "b",
      change: "change-a",
      document: "doc-a",
      action: "action-a",
    }));
    await expectReject(client, aiSnapshotInsert({ workspace: "b", run: "run-a", document: "doc-a" }));
    await expectReject(client, collaborationUpdateInsert({
      workspace: "a",
      document: "doc-a",
      seq: 2,
      semanticAction: "action-b",
    }));

    await expectReject(client, collaborationUpdateInsert({ workspace: "a", document: "doc-a", seq: 2 }));
    await expectReject(client, collaborationActionInsert({
      id: "action-duplicate-command",
      workspace: "a",
      document: "doc-a",
      command: "command-a",
    }));
    await expectReject(client, approvalInsert({ id: "approval-second", workspace: "a", document: "doc-a" }));

    await expectReject(client, "UPDATE collaboration_documents SET checkpoint_seq = 2 WHERE document_id = 'doc-a'");
    await expectReject(client, `UPDATE collaboration_documents SET head_seq = ${MAX_SAFE_INTEGER + 1} WHERE document_id = 'doc-a'`);
    await expectReject(client, collaborationUpdateInsert({ workspace: "a", document: "doc-a", seq: 0 }));
    await expectReject(client, collaborationUpdateInsert({ workspace: "a", document: "doc-a", seq: 1.5 }));
    await expectReject(client, collaborationUpdateInsert({
      workspace: "a",
      document: "doc-a",
      seq: MAX_SAFE_INTEGER + 1,
    }));
    await expectReject(client, authorizationEpochInsert("epoch-negative", -1));
    await expectReject(client, authorizationEpochInsert("epoch-fractional", 0.5));
    await expectReject(client, authorizationEpochInsert("epoch-too-large", MAX_SAFE_INTEGER + 1));
    await expectReject(client, approvalInsert({
      id: "approval-incoherent",
      workspace: "b",
      document: "doc-b",
      invalidatedSeq: 2,
    }));
    await expectReject(client, anchorInsert({
      workspace: "a",
      proposal: "proposal-a",
      document: "doc-a",
      startAssoc: 0,
    }));
    await expectReject(client, collaborationActionInsert({
      id: "action-incoherent",
      workspace: "b",
      document: "doc-b",
      command: "command-incoherent",
      status: "applied",
      appliedHead: null,
    }));

    await client.execute("DELETE FROM documents WHERE workspace_id = 'workspace-a' AND id = 'doc-a'");
    for (const table of COLLABORATION_TABLES.filter((table) => table !== "collaboration_authorization_epochs")) {
      expect(await rowCount(client, table, "workspace-a"), table).toBe(0);
    }
    expect(await rowCount(client, "collaboration_authorization_epochs", "workspace-a")).toBe(1);
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("upgrades populated 0014 data without changing legacy rows or bootstrapping collaboration", async () => {
    const client = await createDatabase("upgrade");
    const database = drizzle(client);
    const pre0015Folder = await createMigrationPrefix(14);
    await migrate(database, { migrationsFolder: pre0015Folder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedLegacyGraph(client, "upgrade");

    const legacyBefore = await snapshotLegacyRows(client, "upgrade");
    await migrate(database, { migrationsFolder });

    expect(await snapshotLegacyRows(client, "upgrade")).toEqual(legacyBefore);
    for (const table of COLLABORATION_TABLES) {
      expect(await rowCount(client, table), table).toBe(0);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });
});

async function createDatabase(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-collaboration-${label}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, `${label}.db`)}` });
  clients.push(client);
  return client;
}

async function createMigrationPrefix(lastIndex: number) {
  const root = await mkdtemp(join(tmpdir(), "coredot-collaboration-prefix-"));
  tempDirs.push(root);
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

async function seedLegacyGraph(client: Client, suffix: string) {
  const workspace = `workspace-${suffix}`;
  await client.execute({
    sql: `INSERT INTO documents (
      id, workspace_id, creation_key, title, content_json, plain_text, status, readiness,
      metadata_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'ready', ?, 1, 1000, 2000)`,
    args: [
      `doc-${suffix}`,
      workspace,
      `creation-${suffix}`,
      `Document ${suffix}`,
      JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: suffix }] }] }),
      `Body ${suffix}`,
      JSON.stringify({ owner: suffix, tags: ["one", "two"] }),
    ],
  });
  await client.execute({
    sql: `INSERT INTO ai_runs (
      id, workspace_id, document_id, command_type, provider, model, idempotency_key,
      operation_fingerprint, input_summary_json, output_text, status, was_applied, created_at, updated_at
    ) VALUES (?, ?, ?, 'document_review', 'stub', 'stub', ?, ?, '{}', 'Output', 'completed', 1, 3000, 3000)`,
    args: [`run-${suffix}`, workspace, `doc-${suffix}`, `run-key-${suffix}`, `run-fingerprint-${suffix}`],
  });
  await client.execute({
    sql: `INSERT INTO ai_proposals (
      id, workspace_id, ai_run_id, document_id, target_text, replacement_text, explanation,
      source, default_apply_mode, result_ordinal, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'old', 'new', 'why', 'review', 'replace', 0, 'accepted', 4000, 4000)`,
    args: [`proposal-${suffix}`, workspace, `run-${suffix}`, `doc-${suffix}`],
  });
  await client.execute({
    sql: `INSERT INTO document_changes (
      id, workspace_id, document_id, principal_id, request_id, kind, before_snapshot_json,
      after_revision, created_at
    ) VALUES (?, ?, ?, ?, ?, 'single', ?, 1, 5000)`,
    args: [
      `change-${suffix}`,
      workspace,
      `doc-${suffix}`,
      `principal-${suffix}`,
      `request-${suffix}`,
      JSON.stringify({
        title: `Before ${suffix}`,
        contentJson: { type: "doc" },
        metadataJson: { owner: suffix },
        readiness: "ready",
      }),
    ],
  });
  await client.execute({
    sql: `INSERT INTO document_change_proposals (
      workspace_id, change_id, document_id, proposal_id, applied_mode, ordinal
    ) VALUES (?, ?, ?, ?, 'replace', 0)`,
    args: [workspace, `change-${suffix}`, `doc-${suffix}`, `proposal-${suffix}`],
  });
}

async function insertCollaborationDocument(client: Client, suffix: string) {
  await client.execute(collaborationDocumentInsert(suffix, `doc-${suffix}`));
}

function collaborationDocumentInsert(
  workspaceSuffix: string,
  document: string,
  generation = 1,
  isCurrent = 1,
) {
  return {
    sql: `INSERT INTO collaboration_documents (
      workspace_id, document_id, generation, is_current, schema_version, schema_fingerprint,
      checkpoint_blob, checkpoint_checksum, head_seq, checkpoint_seq, projected_seq,
      last_checkpoint_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, X'0102', ?, 1, 0, 0, 6000, 6000, 6000)`,
    args: [`workspace-${workspaceSuffix}`, document, generation, isCurrent, HASH_A, HASH_B],
  };
}

async function insertFullCollaborationGraph(client: Client, suffix: string) {
  await client.execute(collaborationActionInsert({
    id: `action-${suffix}`,
    workspace: suffix,
    document: `doc-${suffix}`,
    command: `command-${suffix}`,
    proposal: `proposal-${suffix}`,
    change: `change-${suffix}`,
  }));
  await client.execute(collaborationUpdateInsert({
    workspace: suffix,
    document: `doc-${suffix}`,
    seq: 1,
    semanticAction: `action-${suffix}`,
  }));
  await client.execute(authorizationEpochInsert(`principal-${suffix}`, 0, suffix));
  await client.execute(approvalInsert({ id: `approval-${suffix}`, workspace: suffix, document: `doc-${suffix}` }));
  await client.execute(anchorInsert({
    workspace: suffix,
    proposal: `proposal-${suffix}`,
    document: `doc-${suffix}`,
  }));
  await client.execute(collaborationChangeInsert({
    workspace: suffix,
    change: `change-${suffix}`,
    document: `doc-${suffix}`,
    action: `action-${suffix}`,
  }));
  await client.execute(aiSnapshotInsert({ workspace: suffix, run: `run-${suffix}`, document: `doc-${suffix}` }));
}

function collaborationUpdateInsert(input: {
  workspace: string;
  document: string;
  generation?: number;
  seq: number;
  semanticAction?: string;
}) {
  return {
    sql: `INSERT INTO collaboration_updates (
      workspace_id, document_id, generation, seq, update_blob, checksum, idempotency_key,
      origin_kind, principal_id, request_id, session_id, semantic_action_id, diagnostic_json, created_at
    ) VALUES (?, ?, ?, ?, X'0304', ?, ?, 'proposal_command', ?, ?, ?, ?, '{}', 7000)`,
    args: [
      `workspace-${input.workspace}`,
      input.document,
      input.generation ?? 1,
      input.seq,
      HASH_A,
      `update-key-${input.workspace}-1`,
      `principal-${input.workspace}`,
      `request-${input.workspace}`,
      `session-${input.workspace}`,
      input.semanticAction ?? null,
    ],
  };
}

function collaborationActionInsert(input: {
  id: string;
  workspace: string;
  document: string;
  command: string;
  proposal?: string;
  change?: string;
  status?: "applied" | "failed" | "pending";
  appliedHead?: number | null;
}) {
  const status = input.status ?? "applied";
  const appliedHead = input.appliedHead === undefined ? (status === "applied" ? 1 : null) : input.appliedHead;
  return {
    sql: `INSERT INTO collaboration_actions (
      id, workspace_id, document_id, generation, command_id, action_type, principal_id, request_id,
      base_head_seq, applied_head_seq, proposal_id, document_change_id, status, failure_category,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 'proposal_apply', ?, ?, 0, ?, ?, ?, ?, ?, 7000, 7000)`,
    args: [
      input.id,
      `workspace-${input.workspace}`,
      input.document,
      input.command,
      `principal-${input.workspace}`,
      `request-${input.workspace}`,
      appliedHead,
      input.proposal ?? null,
      input.change ?? null,
      status,
      status === "failed" ? "proposal_target_conflict" : null,
    ],
  };
}

function authorizationEpochInsert(principal: string, epoch: number, workspace = "a") {
  return {
    sql: `INSERT INTO collaboration_authorization_epochs (
      workspace_id, principal_id, epoch, updated_at
    ) VALUES (?, ?, ?, 7000)`,
    args: [`workspace-${workspace}`, principal, epoch],
  };
}

function approvalInsert(input: {
  id: string;
  workspace: string;
  document: string;
  invalidatedSeq?: number;
}) {
  const invalidated = input.invalidatedSeq !== undefined;
  return {
    sql: `INSERT INTO document_approvals (
      id, workspace_id, document_id, generation, approved_head_seq, approved_state_vector,
      approved_content_hash, principal_id, request_id, approved_at, invalidated_seq,
      invalidated_principal_id, invalidated_at
    ) VALUES (?, ?, ?, 1, 1, X'0506', ?, ?, ?, 7000, ?, ?, ?)`,
    args: [
      input.id,
      `workspace-${input.workspace}`,
      input.document,
      HASH_A,
      `principal-${input.workspace}`,
      `request-${input.workspace}`,
      input.invalidatedSeq ?? null,
      invalidated ? null : null,
      invalidated ? 8000 : null,
    ],
  };
}

function anchorInsert(input: {
  workspace: string;
  proposal: string;
  document: string;
  startAssoc?: number;
}) {
  return {
    sql: `INSERT INTO collaboration_proposal_anchors (
      workspace_id, proposal_id, document_id, generation, schema_fingerprint, base_head_seq,
      base_state_vector, start_relative, start_assoc, end_relative, end_assoc,
      target_hash, target_preview, created_at
    ) VALUES (?, ?, ?, 1, ?, 1, X'0708', X'0910', ?, X'1112', 1, ?, 'preview', 7000)`,
    args: [
      `workspace-${input.workspace}`,
      input.proposal,
      input.document,
      HASH_A,
      input.startAssoc ?? -1,
      HASH_B,
    ],
  };
}

function collaborationChangeInsert(input: {
  workspace: string;
  change: string;
  document: string;
  action: string;
}) {
  return {
    sql: `INSERT INTO collaboration_document_changes (
      workspace_id, change_id, document_id, generation, action_id, forward_seq, inverse_update,
      affected_start_relative, affected_end_relative, postcondition_fingerprint,
      base_head_seq, resulting_head_seq
    ) VALUES (?, ?, ?, 1, ?, 1, X'1314', X'1516', X'1718', ?, 0, 1)`,
    args: [`workspace-${input.workspace}`, input.change, input.document, input.action, HASH_A],
  };
}

function aiSnapshotInsert(input: { workspace: string; run: string; document: string }) {
  return {
    sql: `INSERT INTO collaboration_ai_run_snapshots (
      workspace_id, ai_run_id, document_id, generation, head_seq, state_vector,
      schema_fingerprint, content_hash, created_at
    ) VALUES (?, ?, ?, 1, 1, X'1920', ?, ?, 7000)`,
    args: [`workspace-${input.workspace}`, input.run, input.document, HASH_A, HASH_B],
  };
}

async function snapshotLegacyRows(client: Client, suffix: string) {
  const workspace = `workspace-${suffix}`;
  const records: Record<string, unknown[]> = {};
  for (const table of [
    "documents",
    "ai_runs",
    "ai_proposals",
    "document_changes",
    "document_change_proposals",
  ]) {
    records[table] = [...(await client.execute({
      sql: `SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`,
      args: [workspace],
    })).rows];
  }
  return records;
}

async function tableNames(client: Client) {
  return (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"))
    .rows.map((row) => String(row.name));
}

async function rowCount(client: Client, table: string, workspace?: string) {
  const result = await client.execute({
    sql: `SELECT count(*) AS count FROM ${table}${workspace ? " WHERE workspace_id = ?" : ""}`,
    args: workspace ? [workspace] : [],
  });
  return Number(result.rows[0]?.count ?? 0);
}

async function expectTableParity(client: Client, table: AnySQLiteTable) {
  const config = getTableConfig(table);
  const dialect = new SQLiteSyncDialect();
  const primaryColumns = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  const primaryOrder = new Map(primaryColumns.map((column, index) => [column.name, index + 1]));
  const expectedColumns = config.columns.map((column) => ({
    defaultValue: normalizeDrizzleDefault(column.default, dialect),
    name: column.name,
    notNull: column.notNull,
    primaryOrder: primaryOrder.get(column.name) ?? 0,
  }));
  const tableInfo = await client.execute(`PRAGMA table_info(${config.name})`);
  const actualColumns = tableInfo.rows.map((row) => ({
    defaultValue: normalizeDefaultValue(row.dflt_value),
    name: String(row.name),
    notNull: Boolean(row.notnull),
    primaryOrder: Number(row.pk),
  }));
  expect(actualColumns, `${config.name} columns`).toEqual(expectedColumns);

  const expectedForeignKeys = config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: getTableName(reference.foreignTable),
      onDelete: (foreignKey.onDelete ?? "no action").toUpperCase(),
    };
  });
  const foreignKeyRows = (await client.execute(`PRAGMA foreign_key_list(${config.name})`)).rows;
  const foreignKeyGroups = new Map<number, typeof foreignKeyRows>();
  for (const row of foreignKeyRows) {
    const id = Number(row.id);
    const group = foreignKeyGroups.get(id) ?? [];
    group.push(row);
    foreignKeyGroups.set(id, group);
  }
  const actualForeignKeys = [...foreignKeyGroups.values()].map((rows) => {
    const ordered = [...rows].sort((left, right) => Number(left.seq) - Number(right.seq));
    return {
      columns: ordered.map((row) => String(row.from)),
      foreignColumns: ordered.map((row) => String(row.to)),
      foreignTable: String(ordered[0]?.table),
      onDelete: String(ordered[0]?.on_delete).toUpperCase(),
    };
  });
  expect(sortMetadata(actualForeignKeys), `${config.name} foreign keys`).toEqual(
    sortMetadata(expectedForeignKeys),
  );

  const indexList = (await client.execute(`PRAGMA index_list(${config.name})`)).rows;
  const actualIndexes = [];
  for (const index of indexList.filter((row) => !String(row.name).startsWith("sqlite_autoindex_"))) {
    const name = String(index.name);
    const columns = (await client.execute(`PRAGMA index_info(${name})`)).rows
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => String(row.name));
    actualIndexes.push({
      columns,
      name,
      partial: Boolean(index.partial),
      unique: Boolean(index.unique),
    });
  }
  const expectedIndexes = config.indexes.map((index) => ({
    columns: index.config.columns.map((column) => {
      if (!("name" in column)) throw new Error(`Unexpected SQL index expression in ${config.name}`);
      return column.name;
    }),
    name: index.config.name,
    partial: index.config.where !== undefined,
    unique: index.config.unique,
  }));
  expect(sortMetadata(actualIndexes), `${config.name} indexes`).toEqual(sortMetadata(expectedIndexes));

  const createSql = String((await client.execute({
    sql: "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    args: [config.name],
  })).rows[0]?.sql ?? "");
  const actualChecks = [...createSql.matchAll(/CONSTRAINT\s+[`"]([^`"]+)[`"]\s+CHECK/giu)]
    .map((match) => match[1])
    .sort();
  expect(actualChecks, `${config.name} named checks`).toEqual(config.checks.map((check) => check.name).sort());
  const normalizedCreateSql = normalizeSql(createSql);
  for (const check of config.checks) {
    const predicate = normalizeSql(dialect.sqlToQuery(check.value).sql)
      .replaceAll(`${config.name}.`, "");
    expect(normalizedCreateSql, `${config.name}.${check.name} predicate`).toContain(predicate);
  }
  for (const index of config.indexes) {
    if (!index.config.where) continue;
    const predicate = normalizeSql(dialect.sqlToQuery(index.config.where).sql)
      .replaceAll(`${config.name}.`, "");
    const indexSql = String((await client.execute({
      sql: "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      args: [index.config.name],
    })).rows[0]?.sql ?? "");
    expect(normalizeSql(indexSql), `${index.config.name} predicate`).toContain(`where ${predicate}`);
  }
}

function sortMetadata<T>(records: T[]) {
  return [...records].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeSql(value: string) {
  return value.replace(/[`"]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function normalizeDrizzleDefault(value: unknown, dialect: SQLiteSyncDialect) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "string") {
    return normalizeDefaultValue(value);
  }
  return normalizeDefaultValue(dialect.sqlToQuery(value as SQL).sql);
}

function normalizeDefaultValue(value: unknown) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/^\((.*)\)$/u, "$1");
}

function correctnessKeyCases(table: string, column: string, where: string) {
  return [
    { label: `${table}.${column} empty`, statement: `UPDATE ${table} SET ${column} = '' WHERE ${where}` },
    { label: `${table}.${column} blank`, statement: `UPDATE ${table} SET ${column} = '   ' WHERE ${where}` },
    { label: `${table}.${column} surrounding whitespace`, statement: `UPDATE ${table} SET ${column} = ' key ' WHERE ${where}` },
    {
      label: `${table}.${column} blob`,
      statement: `UPDATE ${table} SET ${column} = CAST('key' AS BLOB) WHERE ${where}`,
    },
    {
      label: `${table}.${column} oversized`,
      statement: {
        sql: `UPDATE ${table} SET ${column} = ? WHERE ${where}`,
        args: ["k".repeat(CORRECTNESS_KEY_BYTES + 1)],
      },
    },
  ];
}

async function expectAllReject(
  client: Client,
  cases: Array<{
    label: string;
    statement: string | { args: unknown[]; sql: string };
  }>,
) {
  const accepted: string[] = [];
  for (const testCase of cases) {
    await client.execute("SAVEPOINT collaboration_constraint_case");
    try {
      await client.execute(testCase.statement as Parameters<Client["execute"]>[0]);
      accepted.push(testCase.label);
    } catch {
      // Expected constraint rejection. Roll back the savepoint below in both paths.
    } finally {
      await client.execute("ROLLBACK TO collaboration_constraint_case");
      await client.execute("RELEASE collaboration_constraint_case");
    }
  }
  expect(accepted, "statements accepted without the required constraint").toEqual([]);
}

async function expectIndex(
  client: Client,
  table: string,
  expected: {
    columns: string[];
    name: string;
    partial: boolean;
    predicate?: string;
    unique: boolean;
  },
) {
  const index = (await client.execute(`PRAGMA index_list(${table})`)).rows
    .find((row) => row.name === expected.name);
  expect(index, expected.name).toBeDefined();
  expect(Boolean(index?.unique), `${expected.name} uniqueness`).toBe(expected.unique);
  expect(Boolean(index?.partial), `${expected.name} partial`).toBe(expected.partial);
  const columns = (await client.execute(`PRAGMA index_info(${expected.name})`)).rows
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => String(row.name));
  expect(columns, `${expected.name} columns`).toEqual(expected.columns);
  if (expected.predicate) {
    const sql = String((await client.execute({
      sql: "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      args: [expected.name],
    })).rows[0]?.sql ?? "").replace(/\s+/gu, " ").toLowerCase();
    expect(sql).toContain(expected.predicate);
  }
}

async function expectReject(client: Client, statement: string | { sql: string; args: unknown[] }) {
  await expect(client.execute(statement as Parameters<Client["execute"]>[0])).rejects.toThrow();
}
