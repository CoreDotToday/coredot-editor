import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const clients: Client[] = [];
const tempDirs: string[] = [];
const HASH = "a".repeat(64);
const COMMAND_FINGERPRINT = "b".repeat(64);

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration command delivery migration", () => {
  it("creates one exact durable update delivery job per semantic action", async () => {
    const schema = await import("./schema");
    expect(schema.collaborationCommandDeliveryJobs).toBeDefined();
    const client = await createDatabase("shape");
    await migrate(drizzle(client), { migrationsFolder });

    const columns = await client.execute("PRAGMA table_info(collaboration_command_delivery_jobs)");
    expect(columns.rows.map((row) => String(row.name))).toEqual([
      "workspace_id",
      "action_id",
      "command_id",
      "command_fingerprint",
      "document_id",
      "generation",
      "seq",
      "checksum",
      "status",
      "attempts",
      "next_attempt_at",
      "failure_category",
      "created_at",
      "updated_at",
    ]);
    expect(columns.rows.filter((row) => Number(row.pk) > 0).map((row) => String(row.name))).toEqual([
      "workspace_id",
      "action_id",
    ]);
    const indexes = await client.execute("PRAGMA index_list(collaboration_command_delivery_jobs)");
    expect(indexes.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      "collaboration_command_delivery_jobs_due_idx",
      "collaboration_command_delivery_jobs_update_unique",
    ]));
    const actionColumns = await client.execute("PRAGMA table_info(collaboration_actions)");
    expect(actionColumns.rows).toContainEqual(expect.objectContaining({
      name: "command_fingerprint",
      notnull: 1,
    }));
  });

  it("enforces exact action and update ownership including the immutable checksum", async () => {
    const client = await createDatabase("constraints");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedSemanticUpdate(client, "workspace-a", "document-a", "action-a");
    await seedSemanticUpdate(client, "workspace-b", "document-b", "action-b");

    await expectReject(
      client,
      `UPDATE collaboration_actions SET command_fingerprint = '${"B".repeat(64)}' WHERE id = 'action-a'`,
    );
    await client.execute(validInsert());
    await expectReject(client, validInsert({ actionId: "action-b" }));
    await expectReject(client, validInsert({ checksum: "b".repeat(64) }));
    await expectReject(client, validInsert({ commandFingerprint: "B".repeat(64) }));
    await expectReject(client, validInsert({ commandId: "other-command" }));
    await expectReject(client, validInsert({ documentId: "document-b" }));
    await expectReject(client, validInsert({ seq: 2 }));
    await expectReject(client, validInsert({ attempts: 5, status: "pending" }));
    await expectReject(client, validInsert({ attempts: 4, nextAttemptAt: null, status: "exhausted" }));
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("applies after a populated 0018 database", async () => {
    const client = await createDatabase("populated-upgrade");
    const database = drizzle(client);
    const through0018 = await createMigrationPrefix(18);
    await migrate(database, { migrationsFolder: through0018 });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedSemanticUpdate(client, "workspace-a", "document-a", "action-a");

    await migrate(database, { migrationsFolder });

    const table = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_command_delivery_jobs'",
    );
    expect(table.rows).toHaveLength(1);
    expect((await client.execute("SELECT id FROM collaboration_actions")).rows).toEqual([
      expect.objectContaining({ id: "action-a" }),
    ]);
    const migrated = await client.execute(
      "SELECT command_fingerprint FROM collaboration_actions WHERE id = 'action-a'",
    );
    expect(String(migrated.rows[0]?.command_fingerprint)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

async function createDatabase(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-command-delivery-migration-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "migration.db")}` });
  clients.push(client);
  return client;
}

async function createMigrationPrefix(lastIndex: number) {
  const root = await mkdtemp(join(tmpdir(), "coredot-command-delivery-prefix-"));
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

async function seedSemanticUpdate(
  client: Client,
  workspaceId: string,
  documentId: string,
  actionId: string,
) {
  await client.execute({
    args: [documentId, workspaceId],
    sql: `INSERT INTO documents (
      id, workspace_id, title, content_json, plain_text, status, readiness,
      metadata_json, revision, created_at, updated_at
    ) VALUES (?, ?, 'Title', '{"type":"doc"}', '', 'draft', 'draft', '{}', 0, 1, 1)`,
  });
  await client.execute({
    args: [workspaceId, documentId, HASH, HASH],
    sql: `INSERT INTO collaboration_documents (
      workspace_id, document_id, generation, is_current, schema_version,
      schema_fingerprint, checkpoint_blob, checkpoint_checksum, head_seq,
      checkpoint_seq, projected_seq, last_checkpoint_at, created_at, updated_at
    ) VALUES (?, ?, 1, 1, 1, ?, X'00', ?, 1, 0, 0, 1, 1, 1)`,
  });
  const actionColumns = await client.execute("PRAGMA table_info(collaboration_actions)");
  const hasFingerprint = actionColumns.rows.some((row) => row.name === "command_fingerprint");
  await client.execute(hasFingerprint ? {
    args: [actionId, workspaceId, documentId, `command-${actionId}`, COMMAND_FINGERPRINT],
    sql: `INSERT INTO collaboration_actions (
      id, workspace_id, document_id, generation, command_id, command_fingerprint, action_type,
      principal_id, request_id, base_head_seq, applied_head_seq, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, 'proposal_apply', 'principal-a', 'request-a', 0, 1, 'applied', 1, 1)`,
  } : {
    args: [actionId, workspaceId, documentId, `command-${actionId}`],
    sql: `INSERT INTO collaboration_actions (
      id, workspace_id, document_id, generation, command_id, action_type,
      principal_id, request_id, base_head_seq, applied_head_seq, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 'proposal_apply', 'principal-a', 'request-a', 0, 1, 'applied', 1, 1)`,
  });
  await client.execute({
    args: [workspaceId, documentId, HASH, `update-${actionId}`, actionId],
    sql: `INSERT INTO collaboration_updates (
      workspace_id, document_id, generation, seq, update_blob, checksum,
      idempotency_key, origin_kind, principal_id, request_id,
      semantic_action_id, created_at
    ) VALUES (?, ?, 1, 1, X'00', ?, ?, 'proposal_command', 'principal-a', 'request-a', ?, 1)`,
  });
}

function validInsert(overrides: {
  actionId?: string;
  attempts?: number;
  checksum?: string;
  commandFingerprint?: string;
  commandId?: string;
  documentId?: string;
  nextAttemptAt?: number | null;
  seq?: number;
  status?: string;
} = {}) {
  const attempts = overrides.attempts ?? 0;
  const status = overrides.status ?? "pending";
  const nextAttemptAt = overrides.nextAttemptAt === undefined ? 1 : overrides.nextAttemptAt;
  return `INSERT INTO collaboration_command_delivery_jobs (
    workspace_id, action_id, command_id, command_fingerprint, document_id, generation, seq, checksum, status,
    attempts, next_attempt_at, failure_category, created_at, updated_at
  ) VALUES (
    'workspace-a', '${overrides.actionId ?? "action-a"}', '${overrides.commandId ?? "command-action-a"}',
    '${overrides.commandFingerprint ?? COMMAND_FINGERPRINT}', '${overrides.documentId ?? "document-a"}',
    1, ${String(overrides.seq ?? 1)}, '${overrides.checksum ?? HASH}', '${status}', ${String(attempts)},
    ${nextAttemptAt === null ? "NULL" : String(nextAttemptAt)},
    ${attempts === 0 ? "NULL" : "'delivery_failed'"}, 1, 1
  )`;
}

async function expectReject(client: Client, statement: string) {
  await expect(client.execute(statement)).rejects.toThrow();
}
