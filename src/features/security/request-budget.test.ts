import { createClient, type Client, type InStatement } from "@libsql/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRequestBudget,
  enforceRequestBudget,
  REQUEST_BUDGET_POLICIES,
  RequestBudgetUnavailableError,
  requestBudgetResponse,
  setRequestBudgetForTests,
} from "./request-budget";

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createBudgetClient(databasePath?: string) {
  const path = databasePath ?? join(await createTempDir(), "budgets.db");
  const client = createClient({ url: `file:${path}` });
  clients.push(client);
  const migration = await readFile(resolve(process.cwd(), "drizzle/0007_request_budgets.sql"), "utf8");
  await client.executeMultiple(migration.replaceAll("--> statement-breakpoint", ""));
  return { client, path };
}

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-request-budget-test-"));
  tempDirs.push(dir);
  return dir;
}

const policy = { limit: 3, windowMs: 60_000 };
const context = {
  authMode: "test" as const,
  principalId: "principal-a",
  requestId: "request-a",
  role: "owner" as const,
  workspaceId: "workspace-a",
};

describe("durable request budget", () => {
  it("defines a conservative provider connection-test budget", () => {
    expect(REQUEST_BUDGET_POLICIES["ai.connection-test"]).toEqual({ limit: 5, windowMs: 60_000 });
  });

  it("defines independent preview and artifact export budgets", () => {
    expect(REQUEST_BUDGET_POLICIES["documents.export-preview"]).toEqual({ limit: 20, windowMs: 60_000 });
    expect(REQUEST_BUDGET_POLICIES["documents.export"]).toEqual({ limit: 20, windowMs: 60_000 });
  });

  it("defines a separate refresh-safe collaboration capability budget", () => {
    expect(REQUEST_BUDGET_POLICIES["collaboration.capability"]).toEqual({
      limit: 120,
      windowMs: 60_000,
    });
  });

  it("allows exactly the configured number of requests and rejects the next request", async () => {
    const { client } = await createBudgetClient();
    const budget = createRequestBudget({ client, policies: { test: policy } });
    const now = new Date("2026-07-12T12:34:20.000Z");

    await expect(budget.consume({ context, now, policyId: "test" })).resolves.toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAt: new Date("2026-07-12T12:35:00.000Z"),
    });
    await budget.consume({ context, now, policyId: "test" });
    await expect(budget.consume({ context, now, policyId: "test" })).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(budget.consume({ context, now, policyId: "test" })).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("never exceeds the limit under parallel consumption", async () => {
    const { client } = await createBudgetClient();
    const budget = createRequestBudget({ client, policies: { test: { limit: 5, windowMs: 60_000 } } });
    const now = new Date("2026-07-12T12:34:20.000Z");

    const results = await Promise.all(
      Array.from({ length: 25 }, () => budget.consume({ context, now, policyId: "test" })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    const stored = await client.execute("SELECT request_count FROM request_budget_buckets");
    expect(stored.rows[0]?.request_count).toBe(5);
  });

  it("never exceeds the first-bucket limit across parallel independent clients", async () => {
    const dir = await createTempDir();
    const path = join(dir, "multi-client.db");
    const first = await createBudgetClient(path);
    const secondClient = createClient({ url: `file:${path}` });
    clients.push(secondClient);
    const policies = { test: { limit: 7, windowMs: 60_000 } };
    const budgets = [
      createRequestBudget({ client: first.client, policies }),
      createRequestBudget({ client: secondClient, policies }),
    ];
    const now = new Date("2026-07-12T12:34:20.000Z");

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => budgets[index % budgets.length]!.consume({ context, now, policyId: "test" })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(7);
    expect((await first.client.execute("SELECT request_count FROM request_budget_buckets")).rows[0]?.request_count).toBe(7);
  });

  it("persists usage across budget and client recreation", async () => {
    const dir = await createTempDir();
    const path = join(dir, "persistent.db");
    const first = await createBudgetClient(path);
    const now = new Date("2026-07-12T12:34:20.000Z");
    await createRequestBudget({ client: first.client, policies: { test: { limit: 1, windowMs: 60_000 } } }).consume({
      context,
      now,
      policyId: "test",
    });
    first.client.close();

    const secondClient = createClient({ url: `file:${path}` });
    clients.push(secondClient);
    const recreated = createRequestBudget({
      client: secondClient,
      policies: { test: { limit: 1, windowMs: 60_000 } },
    });

    await expect(recreated.consume({ context, now, policyId: "test" })).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("keeps workspace and principal buckets independent and resets at the fixed boundary", async () => {
    const { client } = await createBudgetClient();
    const budget = createRequestBudget({ client, policies: { test: { limit: 1, windowMs: 60_000 } } });
    const now = new Date("2026-07-12T12:34:59.999Z");
    await budget.consume({ context, now, policyId: "test" });

    await expect(
      budget.consume({ context: { ...context, workspaceId: "workspace-b" }, now, policyId: "test" }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      budget.consume({ context: { ...context, principalId: "principal-b" }, now, policyId: "test" }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      budget.consume({ context, now: new Date("2026-07-12T12:35:00.000Z"), policyId: "test" }),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it("prunes expired buckets and formats a standards-friendly 429 response", async () => {
    const { client } = await createBudgetClient();
    const budget = createRequestBudget({ client, policies: { test: { limit: 1, windowMs: 60_000 } } });
    const now = new Date("2026-07-12T12:34:20.000Z");
    await budget.consume({ context, now, policyId: "test" });
    const exhausted = await budget.consume({ context, now, policyId: "test" });

    const response = requestBudgetResponse(exhausted, now);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Request rate limit exceeded" });
    expect(response.headers.get("Retry-After")).toBe("40");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe("1783859700");

    await expect(budget.pruneExpired(new Date("2026-07-12T12:40:00.000Z"))).resolves.toBe(1);
    expect((await client.execute("SELECT count(*) AS count FROM request_budget_buckets")).rows[0]?.count).toBe(0);
  });

  it("keeps recently expired buckets through clock skew and cannot recreate allowance after an ahead instance prunes", async () => {
    const { client } = await createBudgetClient();
    const budget = createRequestBudget({ client, policies: { test: { limit: 1, windowMs: 60_000 } } });
    const behind = new Date("2026-07-12T12:34:59.000Z");
    const ahead = new Date("2026-07-12T12:36:01.000Z");

    await budget.consume({ context, now: behind, policyId: "test" });
    await expect(budget.pruneExpired(ahead)).resolves.toBe(0);
    await expect(budget.consume({ context, now: behind, policyId: "test" })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("returns the consume result even when best-effort pruning fails", async () => {
    const { client } = await createBudgetClient();
    const execute = async (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.startsWith("DELETE FROM request_budget_buckets")) throw new Error("prune unavailable");
      return client.execute(statement);
    };
    const budget = createRequestBudget({
      client: { execute: execute as Client["execute"] },
      policies: { test: { limit: 1, windowMs: 60_000 } },
    });

    await expect(budget.consume({ context, now: new Date("2026-07-12T12:34:20.000Z"), policyId: "test" }))
      .resolves.toMatchObject({ allowed: true });
  });

  it("retries transient SQLITE_BUSY failures around the atomic consume", async () => {
    const { client } = await createBudgetClient();
    let attempts = 0;
    const execute = async (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("INSERT INTO request_budget_buckets") && attempts++ < 2) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return client.execute(statement);
    };
    const budget = createRequestBudget({
      client: { execute: execute as Client["execute"] },
      policies: { test: { limit: 1, windowMs: 60_000 } },
      retryDelayMs: 1,
    });

    await expect(budget.consume({ context, now: new Date("2026-07-12T12:34:20.000Z"), policyId: "test" }))
      .resolves.toMatchObject({ allowed: true });
    expect(attempts).toBe(3);
  });

  it("recovers when another SQLite client briefly holds the write lock", async () => {
    const dir = await createTempDir();
    const path = join(dir, "write-lock.db");
    const { client } = await createBudgetClient(path);
    const blocker = createClient({ url: `file:${path}` });
    clients.push(blocker);
    await blocker.execute("BEGIN IMMEDIATE");
    const budget = createRequestBudget({
      client,
      policies: { test: { limit: 1, windowMs: 60_000 } },
      retryDelayMs: 25,
    });
    const release = setTimeout(() => void blocker.execute("COMMIT"), 20);

    try {
      await expect(budget.consume({ context, policyId: "test" })).resolves.toMatchObject({ allowed: true });
    } finally {
      clearTimeout(release);
      await blocker.execute("ROLLBACK").catch(() => undefined);
    }
  });

  it("fails closed with 503 and Retry-After after bounded busy retries", async () => {
    const execute = async (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("INSERT INTO request_budget_buckets")) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
      }
      return { rows: [], rowsAffected: 0 } as never;
    };
    const budget = createRequestBudget({
      client: { execute: execute as Client["execute"] },
      policies: { test: { limit: 1, windowMs: 60_000 } },
      retryDelayMs: 1,
    });

    await expect(budget.consume({ context, policyId: "test" })).rejects.toBeInstanceOf(RequestBudgetUnavailableError);
    setRequestBudgetForTests({
      consume: async () => {
        throw new RequestBudgetUnavailableError();
      },
    });
    const response = await enforceRequestBudget(context, "ai.review");
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("1");
    await expect(response?.json()).resolves.toEqual({ error: "Request rate limit temporarily unavailable" });
  });

  it("prunes expired buckets automatically on production consumption without deleting active buckets", async () => {
    const { client } = await createBudgetClient();
    await client.execute(`
      INSERT INTO request_budget_buckets
        (workspace_id, principal_id, policy_id, window_start, request_count, expires_at)
      VALUES ('expired-workspace', 'expired-principal', 'test', 0, 1, 1)
    `);
    const budget = createRequestBudget({
      client,
      policies: { test: { limit: 2, windowMs: 60_000 } },
      pruneIntervalMs: 300_000,
    });
    const now = new Date("2026-07-12T12:34:20.000Z");

    await budget.consume({ context, now, policyId: "test" });

    const rows = await client.execute("SELECT workspace_id, request_count FROM request_budget_buckets");
    expect(rows.rows).toEqual([expect.objectContaining({ request_count: 1, workspace_id: "workspace-a" })]);
  });

  it("bounds automatic pruning to once per interval and retries it after budget recreation", async () => {
    const { client } = await createBudgetClient();
    let pruneCalls = 0;
    const tracedExecute = async (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.startsWith("DELETE FROM request_budget_buckets")) pruneCalls += 1;
      return client.execute(statement);
    };
    const tracedClient = { execute: tracedExecute as Client["execute"] };
    const policies = { test: { limit: 10, windowMs: 60_000 } };
    const first = createRequestBudget({ client: tracedClient, policies, pruneIntervalMs: 300_000 });
    const now = new Date("2026-07-12T12:34:20.000Z");

    await first.consume({ context, now, policyId: "test" });
    await first.consume({ context, now: new Date(now.getTime() + 1_000), policyId: "test" });
    expect(pruneCalls).toBe(1);

    const recreated = createRequestBudget({ client: tracedClient, policies, pruneIntervalMs: 300_000 });
    await recreated.consume({ context, now: new Date(now.getTime() + 2_000), policyId: "test" });
    expect(pruneCalls).toBe(2);
  });
});
