import { createClient, type Client } from "@libsql/client";
import { pathToFileURL } from "node:url";
import { getDatabaseUrl } from "../../src/db/url";

const SOURCE_WORKSPACE_ID = "local";
const TABLES = {
  aiProposals: "ai_proposals",
  aiRuns: "ai_runs",
  appSettings: "app_settings",
  documents: "documents",
  promptTemplates: "prompt_templates",
} as const;

export type ClaimLocalWorkspaceSummary = {
  aiProposals: number;
  aiRuns: number;
  appSettings: number;
  documents: number;
  promptTemplates: number;
  targetWorkspaceId: string;
};

export async function claimLocalWorkspace(
  client: Pick<Client, "transaction">,
  targetWorkspaceId: string,
  options: { dryRun?: boolean } = {},
): Promise<ClaimLocalWorkspaceSummary> {
  const target = validateTargetWorkspaceId(targetWorkspaceId);
  const transaction = await client.transaction("write");
  let completed = false;

  try {
    await transaction.execute("PRAGMA defer_foreign_keys=ON");
    const summary = await getSummary(transaction, target);
    await assertNoConflicts(transaction, target, summary);

    if (options.dryRun) {
      await transaction.rollback();
      completed = true;
      return summary;
    }

    if (
      summary.documents + summary.promptTemplates + summary.aiRuns + summary.aiProposals + summary.appSettings > 0
    ) {
      // Parents move first while composite foreign keys are deferred. The ai_runs
      // trigger then observes the already-moved prompt template when children move.
      await transaction.execute({
        sql: "UPDATE prompt_templates SET workspace_id = ? WHERE workspace_id = ?",
        args: [target, SOURCE_WORKSPACE_ID],
      });
      await transaction.execute({
        sql: "UPDATE documents SET workspace_id = ? WHERE workspace_id = ?",
        args: [target, SOURCE_WORKSPACE_ID],
      });
      await transaction.execute({
        sql: "UPDATE ai_runs SET workspace_id = ? WHERE workspace_id = ?",
        args: [target, SOURCE_WORKSPACE_ID],
      });
      await transaction.execute({
        sql: "UPDATE ai_proposals SET workspace_id = ? WHERE workspace_id = ?",
        args: [target, SOURCE_WORKSPACE_ID],
      });
      await transaction.execute({
        sql: "UPDATE app_settings SET workspace_id = ? WHERE workspace_id = ?",
        args: [target, SOURCE_WORKSPACE_ID],
      });

      const violations = await transaction.execute("PRAGMA foreign_key_check");
      if (violations.rows.length > 0) {
        throw new Error("Legacy workspace claim would violate foreign keys; no rows were moved");
      }
    }

    await transaction.commit();
    completed = true;
    return summary;
  } catch (error) {
    if (!completed) {
      await transaction.rollback().catch(() => undefined);
      completed = true;
    }
    throw error;
  } finally {
    if (!completed) transaction.close();
  }
}

function validateTargetWorkspaceId(value: string) {
  const target = value.trim();
  if (!target) throw new Error("Target workspace ID must be non-empty after trimming");
  if (target === SOURCE_WORKSPACE_ID) throw new Error('The workspace ID "local" is reserved and cannot be claimed');
  return target;
}

async function getSummary(
  transaction: Awaited<ReturnType<Client["transaction"]>>,
  targetWorkspaceId: string,
): Promise<ClaimLocalWorkspaceSummary> {
  const counts: Array<readonly [keyof typeof TABLES, number]> = [];
  for (const [key, table] of Object.entries(TABLES) as Array<[keyof typeof TABLES, string]>) {
    const result = await transaction.execute({
      sql: `SELECT count(*) AS count FROM ${table} WHERE workspace_id = ?`,
      args: [SOURCE_WORKSPACE_ID],
    });
    counts.push([key, Number(result.rows[0]?.count ?? 0)]);
  }

  return {
    aiProposals: 0,
    aiRuns: 0,
    appSettings: 0,
    documents: 0,
    promptTemplates: 0,
    ...Object.fromEntries(counts),
    targetWorkspaceId,
  };
}

async function assertNoConflicts(
  transaction: Awaited<ReturnType<Client["transaction"]>>,
  target: string,
  summary: ClaimLocalWorkspaceSummary,
) {
  if (summary.promptTemplates > 0) {
    const builtins = await transaction.execute({
      sql: `
        SELECT source.builtin_key
        FROM prompt_templates source
        JOIN prompt_templates target
          ON target.workspace_id = ? AND target.builtin_key = source.builtin_key
        WHERE source.workspace_id = ? AND source.builtin_key IS NOT NULL
        ORDER BY source.builtin_key
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (builtins.rows.length > 0) {
      const keys = builtins.rows.map((row) => row.builtin_key).join(", ");
      throw new Error(`Built-in template ${keys} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }

  if (summary.appSettings > 0) {
    const targetSettings = await transaction.execute({
      sql: "SELECT 1 FROM app_settings WHERE workspace_id = ? LIMIT 1",
      args: [target],
    });
    if (targetSettings.rows.length > 0) {
      throw new Error(`Settings conflict for target workspace ${target}. Remove or merge target settings before retrying.`);
    }
  }
}

function parseArguments(argv: string[]) {
  const workspaceArgument = argv.find((argument) => argument.startsWith("--workspace="));
  const targetWorkspaceId = workspaceArgument?.slice("--workspace=".length) ?? "";
  return { dryRun: argv.includes("--dry-run"), targetWorkspaceId };
}

async function main() {
  const { dryRun, targetWorkspaceId } = parseArguments(process.argv.slice(2));
  const client = createClient({ url: getDatabaseUrl() });
  try {
    const summary = await claimLocalWorkspace(client, targetWorkspaceId, { dryRun });
    console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
