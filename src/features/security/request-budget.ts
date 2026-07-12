import type { Client, InStatement } from "@libsql/client";
import { NextResponse } from "next/server";
import type { RequestContext } from "@/features/auth/request-context";

export const REQUEST_BUDGET_POLICIES = Object.freeze({
  "ai.connection-test": { limit: 5, windowMs: 60_000 },
  "ai.review": { limit: 20, windowMs: 60_000 },
  "ai.rewrite": { limit: 20, windowMs: 60_000 },
  "documents.create": { limit: 30, windowMs: 60_000 },
  "documents.export": { limit: 20, windowMs: 60_000 },
  "documents.import": { limit: 10, windowMs: 60_000 },
});
export const REQUEST_BUDGET_PRUNE_INTERVAL_MS = 5 * 60_000;
/** Keep expired buckets for at least five minutes so moderately skewed instances cannot recreate allowance. */
export const REQUEST_BUDGET_CLOCK_SKEW_GRACE_MS = 5 * 60_000;
const REQUEST_BUDGET_BUSY_RETRY_ATTEMPTS = 3;
const REQUEST_BUDGET_BUSY_RETRY_DELAY_MS = 25;

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

export class RequestBudgetUnavailableError extends Error {
  constructor(message = "Request budget storage is temporarily unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestBudgetUnavailableError";
  }
}

export function createRequestBudget<TPolicyId extends string>(options: {
  client: Pick<Client, "execute">;
  policies: Record<TPolicyId, RequestBudgetPolicy>;
  pruneIntervalMs?: number;
  retryDelayMs?: number;
}) {
  const pruneIntervalMs = options.pruneIntervalMs ?? REQUEST_BUDGET_PRUNE_INTERVAL_MS;
  if (!Number.isSafeInteger(pruneIntervalMs) || pruneIntervalMs <= 0) {
    throw new Error("Request budget prune interval must be a positive integer");
  }
  const retryDelayMs = options.retryDelayMs ?? REQUEST_BUDGET_BUSY_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Request budget retry delay must be a non-negative integer");
  }
  let nextPruneAtMs = 0;

  async function pruneExpired(now = new Date()): Promise<number> {
    const result = await options.client.execute({
      sql: "DELETE FROM request_budget_buckets WHERE expires_at <= ?",
      args: [now.getTime() - REQUEST_BUDGET_CLOCK_SKEW_GRACE_MS],
    });
    return result.rowsAffected;
  }

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
      const statement = {
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
      };
      const result = await executeAtomicConsumeWithRetry(options.client, statement, retryDelayMs);

      const count = result.rows[0]?.request_count;
      const allowed = typeof count === "number" || typeof count === "bigint";
      const numericCount = allowed ? Number(count) : policy.limit;
      const budgetResult = {
        allowed,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - numericCount),
        retryAt: new Date(retryAtMs),
      };

      // Retention is maintenance, not part of admission. Run it only after the
      // atomic consume committed and never turn successful admission into a 500.
      if (nowMs >= nextPruneAtMs) {
        nextPruneAtMs = nowMs + pruneIntervalMs;
        try {
          await pruneExpired(now);
        } catch {
          // Best effort. A later interval or process instance will retry.
        }
      }

      return budgetResult;
    },

    pruneExpired,
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
  try {
    const result = await budget.consume({ context, now, policyId });
    return result.allowed ? null : requestBudgetResponse(result, now);
  } catch (error) {
    if (error instanceof RequestBudgetUnavailableError) return requestBudgetUnavailableResponse();
    throw error;
  }
}

export function requestBudgetUnavailableResponse() {
  return NextResponse.json(
    { error: "Request rate limit temporarily unavailable" },
    { status: 503, headers: { "Retry-After": "1" } },
  );
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

async function executeAtomicConsumeWithRetry(
  client: Pick<Client, "execute">,
  statement: InStatement,
  retryDelayMs: number,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_BUDGET_BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await client.execute(statement);
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteContention(error)) throw error;
      if (attempt + 1 < REQUEST_BUDGET_BUSY_RETRY_ATTEMPTS) {
        await delay(retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw new RequestBudgetUnavailableError(undefined, { cause: lastError });
}

function isRetryableSqliteContention(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code).toUpperCase() : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is )?locked/i.test(message);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
