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

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration workflow notification migration", () => {
  it("creates one bounded coalescing job shape per Workspace document", async () => {
    const schema = await import("./schema");
    expect(schema.collaborationWorkflowNotificationJobs).toBeDefined();
    const client = await createDatabase("shape");
    await migrate(drizzle(client), { migrationsFolder });

    const columns = await client.execute("PRAGMA table_info(collaboration_workflow_notification_jobs)");
    expect(columns.rows.map((row) => String(row.name))).toEqual([
      "workspace_id",
      "document_id",
      "generation",
      "workflow_revision",
      "status",
      "attempts",
      "next_attempt_at",
      "failure_category",
      "created_at",
      "updated_at",
    ]);
    expect(columns.rows.filter((row) => Number(row.pk) > 0).map((row) => String(row.name))).toEqual([
      "workspace_id",
      "document_id",
    ]);
    const indexes = await client.execute("PRAGMA index_list(collaboration_workflow_notification_jobs)");
    expect(indexes.rows.map((row) => String(row.name))).toContain(
      "collaboration_workflow_notification_jobs_due_idx",
    );
  });

  it("enforces exact generation ownership and canonical bounded retry states", async () => {
    const client = await createDatabase("constraints");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client, "workspace-a", "document-a");
    await seedParent(client, "workspace-b", "document-b");

    await client.execute(validInsert());
    await expectReject(client, validInsert({
      documentId: "document-b",
      generation: 2,
      workspaceId: "workspace-b",
    }));
    await expectReject(client, validInsert({ attempts: -1 }));
    await expectReject(client, validInsert({ attempts: 5, status: "pending" }));
    await expectReject(client, validInsert({ attempts: 4, nextAttemptAt: null, status: "exhausted" }));
    await expectReject(client, validInsert({ workflowRevision: 0 }));
    await expectReject(client, validInsert({
      documentId: "document-b",
      workspaceId: "workspace-a",
    }));
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("applies after a populated 0017 database instead of being skipped by migration ordering", async () => {
    const client = await createDatabase("populated-upgrade");
    const database = drizzle(client);
    const through0017 = await createMigrationPrefix(17);
    await migrate(database, { migrationsFolder: through0017 });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client, "workspace-a", "document-a");

    await migrate(database, { migrationsFolder });

    const table = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_workflow_notification_jobs'",
    );
    expect(table.rows).toHaveLength(1);
    expect((await client.execute("SELECT id FROM documents")).rows).toEqual([
      expect.objectContaining({ id: "document-a" }),
    ]);
  });
});

async function createDatabase(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-workflow-notification-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "migration.db")}` });
  clients.push(client);
  return client;
}

async function createMigrationPrefix(lastIndex: number) {
  const root = await mkdtemp(join(tmpdir(), "coredot-workflow-notification-prefix-"));
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

async function seedParent(client: Client, workspaceId: string, documentId: string) {
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
    ) VALUES (?, ?, 1, 1, 1, ?, X'00', ?, 0, 0, 0, 1, 1, 1)`,
  });
}

function validInsert(overrides: {
  attempts?: number;
  documentId?: string;
  generation?: number;
  nextAttemptAt?: number | null;
  status?: string;
  workflowRevision?: number;
  workspaceId?: string;
} = {}) {
  const attempts = overrides.attempts ?? 0;
  const status = overrides.status ?? "pending";
  const nextAttemptAt = overrides.nextAttemptAt === undefined ? 1 : overrides.nextAttemptAt;
  const failureCategory = attempts === 0 ? "NULL" : "'delivery_failed'";
  return `INSERT INTO collaboration_workflow_notification_jobs (
    workspace_id, document_id, generation, workflow_revision, status, attempts,
    next_attempt_at, failure_category, created_at, updated_at
  ) VALUES (
    '${overrides.workspaceId ?? "workspace-a"}', '${overrides.documentId ?? "document-a"}',
    ${String(overrides.generation ?? 1)}, ${String(overrides.workflowRevision ?? 1)},
    '${status}', ${String(attempts)}, ${nextAttemptAt === null ? "NULL" : String(nextAttemptAt)},
    ${failureCategory}, 1, 1
  )`;
}

async function expectReject(client: Client, statement: string) {
  await expect(client.execute(statement)).rejects.toThrow();
}
