import type { Client } from "@libsql/client";
import { NextResponse } from "next/server";
import type { RequestContext } from "@/features/auth/request-context";

export const REQUEST_BUDGET_POLICIES = Object.freeze({
  "ai.review": { limit: 20, windowMs: 60_000 },
  "ai.rewrite": { limit: 20, windowMs: 60_000 },
  "documents.create": { limit: 30, windowMs: 60_000 },
  "documents.export": { limit: 20, windowMs: 60_000 },
  "documents.import": { limit: 10, windowMs: 60_000 },
});

export type RequestBudgetPolicyId = keyof typeof REQUEST_BUDGET_POLICIES;
export type RequestBudgetPolicy = { limit: number; windowMs: number };
export type RequestBudgetResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAt: Date;
};

type BudgetScope = Pick<RequestContext, "principalId" | "workspaceId">;
type ConsumeInput<TPolicyId extends string> = {
  context?: BudgetScope;
  scope?: BudgetScope;
  policyId: TPolicyId;
  now?: Date;
};

export function createRequestBudget<TPolicyId extends string>(options: {
  client: Pick<Client, "execute">;
  policies: Record<TPolicyId, RequestBudgetPolicy>;
}) {
  return {
    async consume(input: ConsumeInput<TPolicyId>): Promise<RequestBudgetResult> {
      const context = input.context ?? input.scope;
      if (!context) {
        throw new Error("Request budget consumption requires a workspace and principal scope");
      }

      const policy = options.policies[input.policyId];
      if (!policy || !Number.isSafeInteger(policy.limit) || policy.limit <= 0 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
        throw new Error(`Invalid request budget policy: ${input.policyId}`);
      }

      const now = input.now ?? new Date();
      const nowMs = now.getTime();
      const windowStartMs = Math.floor(nowMs / policy.windowMs) * policy.windowMs;
      const retryAtMs = windowStartMs + policy.windowMs;

      // A single UPSERT is the concurrency boundary. SQLite serializes this write and
      // the WHERE predicate prevents the stored counter from ever exceeding the limit.
      const result = await options.client.execute({
        sql: `
          INSERT INTO request_budget_buckets (
            workspace_id, principal_id, policy_id, window_start, request_count, expires_at
          ) VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT (workspace_id, principal_id, policy_id, window_start)
          DO UPDATE SET
            request_count = request_budget_buckets.request_count + 1,
            expires_at = excluded.expires_at
          WHERE request_budget_buckets.request_count < ?
          RETURNING request_count
        `,
        args: [
          context.workspaceId,
          context.principalId,
          input.policyId,
          windowStartMs,
          retryAtMs,
          policy.limit,
        ],
      });

      const count = result.rows[0]?.request_count;
      const allowed = typeof count === "number" || typeof count === "bigint";
      const numericCount = allowed ? Number(count) : policy.limit;
      return {
        allowed,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - numericCount),
        retryAt: new Date(retryAtMs),
      };
    },

    async pruneExpired(now = new Date()): Promise<number> {
      const result = await options.client.execute({
        sql: "DELETE FROM request_budget_buckets WHERE expires_at <= ?",
        args: [now.getTime()],
      });
      return result.rowsAffected;
    },
  };
}

type RequestBudget = ReturnType<typeof createRequestBudget<RequestBudgetPolicyId>>;
let defaultRequestBudget: Pick<RequestBudget, "consume"> | null = null;
let activeRequestBudget: Pick<RequestBudget, "consume"> | null = null;

export async function enforceRequestBudget(
  context: BudgetScope,
  policyId: RequestBudgetPolicyId,
  now = new Date(),
): Promise<Response | null> {
  const budget = activeRequestBudget ?? (await getDefaultRequestBudget());
  const result = await budget.consume({ context, now, policyId });
  return result.allowed ? null : requestBudgetResponse(result, now);
}

export function requestBudgetResponse(result: RequestBudgetResult, now = new Date()) {
  const retrySeconds = Math.max(0, Math.ceil((result.retryAt.getTime() - now.getTime()) / 1_000));
  return NextResponse.json(
    { error: "Request rate limit exceeded" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retrySeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.retryAt.getTime() / 1_000)),
      },
    },
  );
}

export function setRequestBudgetForTests(budget: Pick<RequestBudget, "consume">) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Request budget overrides are test-only");
  }
  activeRequestBudget = budget;
}

export function resetRequestBudgetForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Request budget overrides are test-only");
  }
  activeRequestBudget = null;
}

async function getDefaultRequestBudget() {
  if (!defaultRequestBudget) {
    const { sqliteClient } = await import("@/db/client");
    defaultRequestBudget = createRequestBudget({ client: sqliteClient, policies: REQUEST_BUDGET_POLICIES });
  }
  return defaultRequestBudget;
}
