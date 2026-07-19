import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("collaboration room closure migration", () => {
  it("exports the durable room closure job table and migrates it with a due-work index", async () => {
    const schema = await import("./schema");
    expect(schema.collaborationRoomClosureJobs).toBeDefined();

    const client = await createDatabase("shape");
    await migrate(drizzle(client), { migrationsFolder });
    const columns = await client.execute("PRAGMA table_info(collaboration_room_closure_jobs)");
    expect(columns.rows.map((row) => String(row.name))).toEqual([
      "workspace_id",
      "document_id",
      "generation",
      "reason",
      "status",
      "attempts",
      "next_attempt_at",
      "failure_category",
      "created_at",
      "updated_at",
    ]);
    const indexes = await client.execute("PRAGMA index_list(collaboration_room_closure_jobs)");
    expect(indexes.rows.map((row) => String(row.name))).toContain(
      "collaboration_room_closure_jobs_due_idx",
    );
  });

  it("enforces Workspace ownership, one job identity, and bounded canonical retry states", async () => {
    const client = await createDatabase("constraints");
    await migrate(drizzle(client), { migrationsFolder });
    await client.execute("PRAGMA foreign_keys=ON");
    await seedParent(client, "workspace-a", "document-a");
    await seedParent(client, "workspace-b", "document-b");

    await client.execute(validInsert());
    await expectReject(client, validInsert());
    await expectReject(client, validInsert({ attempts: 6 }));
    await expectReject(client, validInsert({ attempts: -1 }));
    await expectReject(client, validInsert({ reason: "revoked" }));
    await expectReject(client, validInsert({ status: "unexpected" }));
    await expectReject(client, validInsert({ attempts: 5, status: "pending" }));
    await expectReject(client, validInsert({ attempts: 4, nextAttemptAt: null, status: "exhausted" }));
    await expectReject(client, validInsert({ nextAttemptAt: 0 }));
    await expectReject(client, validInsert({
      documentId: "document-b",
      workspaceId: "workspace-a",
    }));
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });
});

async function createDatabase(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-room-closure-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "migration.db")}` });
  clients.push(client);
  return client;
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
  nextAttemptAt?: number | null;
  reason?: string;
  status?: string;
  workspaceId?: string;
} = {}) {
  const workspaceId = overrides.workspaceId ?? "workspace-a";
  const documentId = overrides.documentId ?? "document-a";
  const attempts = overrides.attempts ?? 0;
  const status = overrides.status ?? "pending";
  const nextAttemptAt = overrides.nextAttemptAt === undefined ? 1 : overrides.nextAttemptAt;
  const failureCategory = attempts === 0 ? "NULL" : "'delivery_failed'";
  return `INSERT INTO collaboration_room_closure_jobs (
    workspace_id, document_id, generation, reason, status, attempts,
    next_attempt_at, failure_category, created_at, updated_at
  ) VALUES (
    '${workspaceId}', '${documentId}', 1, '${overrides.reason ?? "archived"}',
    '${status}', ${String(attempts)}, ${nextAttemptAt === null ? "NULL" : String(nextAttemptAt)},
    ${failureCategory}, 1, 1
  )`;
}

async function expectReject(client: Client, statement: string) {
  await expect(client.execute(statement)).rejects.toThrow();
}
