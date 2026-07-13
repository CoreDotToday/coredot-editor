import { createClient, type Client } from "@libsql/client";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { recoverStaleAiRuns } from "./recover-stale-runs";

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createRecoveryDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-ai-recovery-test-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "recovery.db")}`;
  const client = createClient({ url });
  clients.push(client);
  const database = drizzle(client, { schema });
  await database.run(sql`
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      prompt_template_id text,
      command_type text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      idempotency_key text,
      operation_fingerprint text,
      retry_not_before_at integer,
      execution_token text,
      input_summary_json text NOT NULL,
      output_text text DEFAULT '' NOT NULL,
      status text NOT NULL,
      was_applied integer DEFAULT false NOT NULL,
      error_message text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
  return { database, url };
}

async function insertRun(
  database: ReturnType<typeof drizzle<typeof schema>>,
  input: {
    executionToken?: string | null;
    id: string;
    retryNotBeforeAt?: Date | null;
    status: "completed" | "failed" | "pending" | "streaming";
    updatedAt: Date;
    workspaceId?: string;
  },
) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  await database.run(sql`
    INSERT INTO ai_runs (
      id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
      idempotency_key, operation_fingerprint, retry_not_before_at, execution_token,
      input_summary_json, output_text, status, was_applied, error_message, created_at, updated_at
    ) VALUES (
      ${input.id}, ${input.workspaceId ?? "workspace_a"}, 'doc_1', NULL, 'document_review',
      'stub', 'stub-editor', ${`key-${input.id}`}, ${`fingerprint-${input.id}`},
      ${input.retryNotBeforeAt?.getTime() ?? null}, ${input.executionToken ?? null}, '{}', '',
      ${input.status}, false, ${input.status === "failed" ? "existing_failure" : null},
      ${createdAt.getTime()}, ${input.updatedAt.getTime()}
    )
  `);
}

describe("recoverStaleAiRuns", () => {
  it("recovers exactly stale active attempts, including legacy null-token rows, and is idempotent", async () => {
    const { database } = await createRecoveryDatabase();
    const before = new Date("2026-01-02T00:00:00.000Z");
    const stale = new Date("2026-01-01T23:59:59.999Z");
    const now = new Date("2026-01-03T00:00:00.000Z");
    const retryLease = new Date("2026-01-04T00:00:00.000Z");
    await insertRun(database, {
      executionToken: "pending-token",
      id: "stale_pending",
      retryNotBeforeAt: retryLease,
      status: "pending",
      updatedAt: stale,
    });
    await insertRun(database, {
      executionToken: "streaming-token",
      id: "stale_streaming",
      status: "streaming",
      updatedAt: stale,
      workspaceId: "workspace_b",
    });
    await insertRun(database, {
      executionToken: null,
      id: "stale_legacy_null_token",
      status: "pending",
      updatedAt: stale,
    });
    await insertRun(database, {
      executionToken: "recent-token",
      id: "recent_pending",
      status: "pending",
      updatedAt: new Date(before.getTime() + 1),
    });
    await insertRun(database, {
      executionToken: "boundary-token",
      id: "boundary_pending",
      status: "pending",
      updatedAt: before,
    });
    await insertRun(database, {
      executionToken: null,
      id: "old_completed",
      status: "completed",
      updatedAt: stale,
    });
    await insertRun(database, {
      executionToken: null,
      id: "old_failed",
      retryNotBeforeAt: retryLease,
      status: "failed",
      updatedAt: stale,
    });

    const first = await recoverStaleAiRuns(database, { before, now });
    const second = await recoverStaleAiRuns(database, { before, now: new Date(now.getTime() + 1) });
    const rows = await database.select().from(schema.aiRuns).orderBy(asc(schema.aiRuns.id));

    expect(first).toEqual({ recoveredCount: 3 });
    expect(second).toEqual({ recoveredCount: 0 });
    expect(rows.filter((row) => [
      "stale_legacy_null_token",
      "stale_pending",
      "stale_streaming",
    ].includes(row.id))).toEqual([
      expect.objectContaining({
        errorMessage: "operation_interrupted",
        executionToken: null,
        id: "stale_legacy_null_token",
        retryNotBeforeAt: null,
        status: "failed",
        updatedAt: now,
        workspaceId: "workspace_a",
      }),
      expect.objectContaining({
        errorMessage: "operation_interrupted",
        executionToken: null,
        id: "stale_pending",
        retryNotBeforeAt: null,
        status: "failed",
        updatedAt: now,
        workspaceId: "workspace_a",
      }),
      expect.objectContaining({
        errorMessage: "operation_interrupted",
        executionToken: null,
        id: "stale_streaming",
        retryNotBeforeAt: null,
        status: "failed",
        updatedAt: now,
        workspaceId: "workspace_b",
      }),
    ]);
    expect(rows.find((row) => row.id === "recent_pending")).toMatchObject({
      executionToken: "recent-token",
      status: "pending",
    });
    expect(rows.find((row) => row.id === "boundary_pending")).toMatchObject({
      executionToken: "boundary-token",
      status: "pending",
    });
    expect(rows.find((row) => row.id === "old_completed")).toMatchObject({
      errorMessage: null,
      status: "completed",
    });
    expect(rows.find((row) => row.id === "old_failed")).toMatchObject({
      errorMessage: "existing_failure",
      retryNotBeforeAt: retryLease,
      status: "failed",
    });
  });

  it("lets concurrent recovery workers claim each stale row at most once", async () => {
    const { database, url } = await createRecoveryDatabase();
    const before = new Date("2026-01-02T00:00:00.000Z");
    const stale = new Date(before.getTime() - 1);
    const now = new Date("2026-01-03T00:00:00.000Z");
    for (const id of ["stale_1", "stale_2", "stale_3"]) {
      await insertRun(database, { executionToken: `token-${id}`, id, status: "pending", updatedAt: stale });
    }
    const otherClient = createClient({ url });
    clients.push(otherClient);
    const otherDatabase = drizzle(otherClient, { schema });

    const results = await Promise.all([
      recoverStaleAiRuns(database, { before, now }),
      recoverStaleAiRuns(otherDatabase, { before, now }),
    ]);
    const rows = await database.select().from(schema.aiRuns).orderBy(asc(schema.aiRuns.id));

    expect(results.reduce((total, result) => total + result.recoveredCount, 0)).toBe(3);
    expect(rows).toEqual([
      expect.objectContaining({ errorMessage: "operation_interrupted", id: "stale_1", status: "failed" }),
      expect.objectContaining({ errorMessage: "operation_interrupted", id: "stale_2", status: "failed" }),
      expect.objectContaining({ errorMessage: "operation_interrupted", id: "stale_3", status: "failed" }),
    ]);
  });

  it("returns only a constant-size aggregate for a large stale backlog", async () => {
    const { database } = await createRecoveryDatabase();
    const before = new Date("2026-01-02T00:00:00.000Z");
    const stale = new Date(before.getTime() - 1);
    const now = new Date("2026-01-03T00:00:00.000Z");
    await database.run(sql`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 1000
      )
      INSERT INTO ai_runs (
        id, workspace_id, document_id, prompt_template_id, command_type, provider, model,
        idempotency_key, operation_fingerprint, retry_not_before_at, execution_token,
        input_summary_json, output_text, status, was_applied, error_message, created_at, updated_at
      )
      SELECT
        printf('bulk_%04d', value), 'workspace_a', 'doc_1', NULL, 'document_review',
        'stub', 'stub-editor', printf('key-bulk-%04d', value), printf('fingerprint-bulk-%04d', value),
        NULL, printf('token-bulk-%04d', value), '{}', '', 'pending', false, NULL,
        ${stale.getTime()}, ${stale.getTime()}
      FROM sequence
    `);

    const result = await recoverStaleAiRuns(database, { before, now });
    const [{ recoveredCount }] = await database.select({ recoveredCount: sql<number>`count(*)` })
      .from(schema.aiRuns)
      .where(sql`${schema.aiRuns.errorMessage} = 'operation_interrupted'`);

    expect(result).toEqual({ recoveredCount: 1000 });
    expect(Object.keys(result)).toEqual(["recoveredCount"]);
    expect(recoveredCount).toBe(1000);
  });
});
