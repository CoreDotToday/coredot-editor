import { createClient, type Client } from "@libsql/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestBudget, requestBudgetResponse } from "./request-budget";

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

    await expect(budget.pruneExpired(new Date("2026-07-12T12:35:00.000Z"))).resolves.toBe(1);
    expect((await client.execute("SELECT count(*) AS count FROM request_budget_buckets")).rows[0]?.count).toBe(0);
  });
});
