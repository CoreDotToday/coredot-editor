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

describe("document approval revocation migration", () => {
  it("adds a complete bounded revocation audit tuple", async () => {
    const client = await createDatabase("revocation-state");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client);

    const columns = await client.execute("PRAGMA table_info(document_approvals)");
    expect(columns.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      "revoked_at",
      "revoked_principal_id",
      "revoked_request_id",
    ]));
    await client.execute(approvalInsert("revoked", {
      revokedAt: 2,
      revokedPrincipalId: "workflow-principal",
      revokedRequestId: "workflow-request",
    }));

    await expectReject(client, approvalInsert("partial", { revokedAt: 2 }));
    await expectReject(client, approvalInsert("oversized", {
      revokedAt: 2,
      revokedPrincipalId: "p".repeat(257),
      revokedRequestId: "workflow-request",
    }));
    await expectReject(client, approvalInsert("boundary-space", {
      revokedAt: 2,
      revokedPrincipalId: " workflow-principal",
      revokedRequestId: "workflow-request",
    }));
    await expectReject(client, approvalInsert("dual-terminal", {
      invalidatedAt: 3,
      invalidatedPrincipalId: "editing-principal",
      invalidatedSeq: 1,
      revokedAt: 2,
      revokedPrincipalId: "workflow-principal",
      revokedRequestId: "workflow-request",
    }));
  });

  it("allows only one approval with neither invalidation nor revocation", async () => {
    const client = await createDatabase("active-unique");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client);

    await client.execute(approvalInsert("active-a"));
    await expectReject(client, approvalInsert("active-b"));
    await client.execute(`UPDATE document_approvals SET
      revoked_at = 2,
      revoked_principal_id = 'workflow-principal',
      revoked_request_id = 'workflow-request'
      WHERE id = 'active-a'`);
    await expect(client.execute(approvalInsert("active-b"))).resolves.toBeDefined();
  });

  it("preserves populated pre-revocation approval history during upgrade", async () => {
    const client = await createDatabase("populated-upgrade");
    const database = drizzle(client);
    const through0016 = await createMigrationPrefix(16);
    await migrate(database, { migrationsFolder: through0016 });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client);
    await client.execute(`INSERT INTO document_approvals (
      id, workspace_id, document_id, generation, approved_head_seq,
      approved_state_vector, approved_content_hash, principal_id, request_id,
      approved_at, invalidated_seq, invalidated_principal_id, invalidated_at
    ) VALUES (
      'historic-approval', 'workspace-a', 'document-a', 1, 0, X'00', '${HASH}',
      'historic-approver', 'historic-request', 1, NULL, NULL, NULL
    )`);

    await migrate(database, { migrationsFolder });

    const result = await client.execute("SELECT * FROM document_approvals");
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: "historic-approval",
        principal_id: "historic-approver",
        request_id: "historic-request",
        revoked_at: null,
        revoked_principal_id: null,
        revoked_request_id: null,
      }),
    ]);
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });
});

async function createDatabase(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-approval-revocation-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "migration.db")}` });
  clients.push(client);
  return client;
}

async function createMigrationPrefix(lastIndex: number) {
  const root = await mkdtemp(join(tmpdir(), "coredot-approval-prefix-"));
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

async function seedParent(client: Client) {
  await client.execute(`INSERT INTO documents (
    id, workspace_id, title, content_json, plain_text, status, readiness,
    metadata_json, revision, created_at, updated_at
  ) VALUES (
    'document-a', 'workspace-a', 'Title', '{"type":"doc"}', '', 'draft',
    'ready', '{}', 0, 1, 1
  )`);
  await client.execute({
    args: [HASH, HASH],
    sql: `INSERT INTO collaboration_documents (
      workspace_id, document_id, generation, is_current, schema_version,
      schema_fingerprint, checkpoint_blob, checkpoint_checksum, head_seq,
      checkpoint_seq, projected_seq, last_checkpoint_at, created_at, updated_at
    ) VALUES (
      'workspace-a', 'document-a', 1, 1, 1, ?, X'00', ?, 0, 0, 0, 1, 1, 1
    )`,
  });
}

function approvalInsert(id: string, options: {
  invalidatedAt?: number;
  invalidatedPrincipalId?: string;
  invalidatedSeq?: number;
  revokedAt?: number;
  revokedPrincipalId?: string;
  revokedRequestId?: string;
} = {}) {
  return `INSERT INTO document_approvals (
    id, workspace_id, document_id, generation, approved_head_seq,
    approved_state_vector, approved_content_hash, principal_id, request_id,
    approved_at, invalidated_seq, invalidated_principal_id, invalidated_at,
    revoked_at, revoked_principal_id, revoked_request_id
  ) VALUES (
    '${id}', 'workspace-a', 'document-a', 1, 0, X'00', '${HASH}',
    'approver', 'approval-request', 1,
    ${sqlValue(options.invalidatedSeq)}, ${sqlValue(options.invalidatedPrincipalId)},
    ${sqlValue(options.invalidatedAt)}, ${sqlValue(options.revokedAt)},
    ${sqlValue(options.revokedPrincipalId)}, ${sqlValue(options.revokedRequestId)}
  )`;
}

function sqlValue(value: number | string | undefined) {
  if (value === undefined) return "NULL";
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

async function expectReject(client: Client, statement: string) {
  await expect(client.execute(statement)).rejects.toThrow();
}
