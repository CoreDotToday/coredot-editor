import { and, inArray, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns } from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";

type AiRunDatabase = typeof db;

export type RecoverStaleAiRunsInput = {
  before: Date;
  now?: Date;
};

export type RecoverStaleAiRunsResult = {
  recoveredCount: number;
};

export async function recoverStaleAiRuns(
  database: AiRunDatabase,
  input: RecoverStaleAiRunsInput,
): Promise<RecoverStaleAiRunsResult> {
  const now = input.now ?? new Date();
  if (
    !Number.isFinite(input.before.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    input.before.getTime() >= now.getTime()
  ) {
    throw new Error("Invalid stale AI run recovery window");
  }

  const recovered = await retrySqliteContention(() => database
    .update(aiRuns)
    .set({
      errorMessage: "operation_interrupted",
      executionToken: null,
      retryNotBeforeAt: null,
      status: "failed",
      updatedAt: now,
    })
    .where(and(
      inArray(aiRuns.status, ["pending", "streaming"]),
      lt(aiRuns.updatedAt, input.before),
    ))
    .run());

  return { recoveredCount: recovered.rowsAffected };
}
