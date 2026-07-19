import { createClient, type Client } from "@libsql/client";
import { pathToFileURL } from "node:url";
import { getDatabaseUrl } from "../../src/db/url";

const SOURCE_WORKSPACE_ID = "local";
const TABLES = [
  { key: "promptTemplates", table: "prompt_templates" },
  { key: "documents", table: "documents" },
  { key: "requestBudgetBuckets", table: "request_budget_buckets" },
  { key: "collaborationAuthorizationEpochs", table: "collaboration_authorization_epochs" },
  { key: "aiRuns", table: "ai_runs" },
  { key: "documentChanges", table: "document_changes" },
  { key: "collaborationDocuments", table: "collaboration_documents" },
  { key: "aiProposals", table: "ai_proposals" },
  { key: "aiWorkspaceConversations", table: "ai_workspace_conversations" },
  { key: "collaborationActions", table: "collaboration_actions" },
  { key: "documentApprovals", table: "document_approvals" },
  { key: "collaborationAiRunSnapshots", table: "collaboration_ai_run_snapshots" },
  { key: "documentChangeProposals", table: "document_change_proposals" },
  { key: "aiWorkspaceMessages", table: "ai_workspace_messages" },
  { key: "collaborationUpdates", table: "collaboration_updates" },
  { key: "collaborationProposalAnchors", table: "collaboration_proposal_anchors" },
  { key: "collaborationDocumentChanges", table: "collaboration_document_changes" },
  { key: "appSettings", table: "app_settings" },
] as const;

type WorkspaceTable = (typeof TABLES)[number];
type WorkspaceTableKey = WorkspaceTable["key"];
const COLLABORATION_TABLE_KEYS = [
  "collaborationActions",
  "collaborationAiRunSnapshots",
  "collaborationAuthorizationEpochs",
  "collaborationDocumentChanges",
  "collaborationDocuments",
  "collaborationProposalAnchors",
  "collaborationUpdates",
  "documentApprovals",
] as const satisfies readonly WorkspaceTableKey[];

export type ClaimLocalWorkspaceSummary = Record<WorkspaceTableKey, number> & {
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
    const availableTables = await getAvailableWorkspaceTables(transaction);
    const summary = await getSummary(transaction, target, availableTables);
    assertCompleteCollaborationGraph(summary, availableTables);
    await assertNoConflicts(transaction, target, summary);

    if (options.dryRun) {
      await transaction.rollback();
      completed = true;
      return summary;
    }

    const totalRows = availableTables.reduce((total, { key }) => total + summary[key], 0);
    if (totalRows > 0) {
      // Parent rows move before their children while composite foreign keys are
      // deferred. In particular, the ai_runs trigger must observe the already
      // moved prompt template. The fixed registry order captures that dependency.
      for (const { table } of availableTables) {
        await transaction.execute({
          sql: `UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`,
          args: [target, SOURCE_WORKSPACE_ID],
        });
      }

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
  availableTables: readonly WorkspaceTable[],
): Promise<ClaimLocalWorkspaceSummary> {
  const counts = Object.fromEntries(TABLES.map(({ key }) => [key, 0])) as Record<WorkspaceTableKey, number>;
  for (const { key, table } of availableTables) {
    const result = await transaction.execute({
      sql: `SELECT count(*) AS count FROM ${table} WHERE workspace_id = ?`,
      args: [SOURCE_WORKSPACE_ID],
    });
    counts[key] = Number(result.rows[0]?.count ?? 0);
  }

  return {
    ...counts,
    targetWorkspaceId,
  };
}

async function getAvailableWorkspaceTables(
  transaction: Awaited<ReturnType<Client["transaction"]>>,
): Promise<WorkspaceTable[]> {
  const placeholders = TABLES.map(() => "?").join(", ");
  const result = await transaction.execute({
    sql: `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${placeholders})`,
    args: TABLES.map(({ table }) => table),
  });
  const availableNames = new Set(result.rows.map((row) => String(row.name)));
  return TABLES.filter(({ table }) => availableNames.has(table));
}

function assertCompleteCollaborationGraph(
  summary: ClaimLocalWorkspaceSummary,
  availableTables: readonly WorkspaceTable[],
) {
  const hasLocalCollaborationRows = COLLABORATION_TABLE_KEYS.some((key) => summary[key] > 0);
  if (hasLocalCollaborationRows && availableTables.length !== TABLES.length) {
    throw new Error(
      "A complete current collaboration schema is required before claiming collaboration rows. Run all migrations and retry.",
    );
  }
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

  if (summary.documents > 0 && await tableHasColumn(transaction, "documents", "creation_key")) {
    const conflicts = await transaction.execute({
      sql: `
        SELECT source.creation_key
        FROM documents source
        JOIN documents target
          ON target.workspace_id = ? AND target.creation_key = source.creation_key
        WHERE source.workspace_id = ? AND source.creation_key IS NOT NULL
        ORDER BY source.creation_key
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (conflicts.rows.length > 0) {
      const keys = conflicts.rows.map((row) => row.creation_key).join(", ");
      throw new Error(`Document creation key ${keys} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }

  if (summary.aiRuns > 0 && await tableHasColumn(transaction, "ai_runs", "idempotency_key")) {
    const conflicts = await transaction.execute({
      sql: `
        SELECT source.idempotency_key
        FROM ai_runs source
        JOIN ai_runs target
          ON target.workspace_id = ? AND target.idempotency_key = source.idempotency_key
        WHERE source.workspace_id = ? AND source.idempotency_key IS NOT NULL
        ORDER BY source.idempotency_key
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (conflicts.rows.length > 0) {
      const keys = conflicts.rows.map((row) => row.idempotency_key).join(", ");
      throw new Error(`AI idempotency key ${keys} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }

  if (summary.aiWorkspaceConversations > 0) {
    const conflicts = await transaction.execute({
      sql: `
        SELECT source.creation_key
        FROM ai_workspace_conversations source
        JOIN ai_workspace_conversations target
          ON target.workspace_id = ? AND target.creation_key = source.creation_key
        WHERE source.workspace_id = ?
        ORDER BY source.creation_key
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (conflicts.rows.length > 0) {
      const keys = conflicts.rows.map((row) => row.creation_key).join(", ");
      throw new Error(`Conversation creation key ${keys} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }

  if (summary.requestBudgetBuckets > 0) {
    const conflicts = await transaction.execute({
      sql: `
        SELECT source.principal_id, source.policy_id, source.window_start
        FROM request_budget_buckets source
        JOIN request_budget_buckets target
          ON target.workspace_id = ?
          AND target.principal_id = source.principal_id
          AND target.policy_id = source.policy_id
          AND target.window_start = source.window_start
        WHERE source.workspace_id = ?
        ORDER BY source.principal_id, source.policy_id, source.window_start
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (conflicts.rows.length > 0) {
      const keys = conflicts.rows
        .map((row) => `${row.principal_id}/${row.policy_id}/${row.window_start}`)
        .join(", ");
      throw new Error(`Request budget ${keys} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }

  if (summary.collaborationAuthorizationEpochs > 0) {
    const conflicts = await transaction.execute({
      sql: `
        SELECT source.principal_id
        FROM collaboration_authorization_epochs source
        JOIN collaboration_authorization_epochs target
          ON target.workspace_id = ? AND target.principal_id = source.principal_id
        WHERE source.workspace_id = ?
        ORDER BY source.principal_id
      `,
      args: [target, SOURCE_WORKSPACE_ID],
    });
    if (conflicts.rows.length > 0) {
      const principals = conflicts.rows.map((row) => row.principal_id).join(", ");
      throw new Error(`Authorization epoch ${principals} conflict in target workspace ${target}. Resolve it before retrying.`);
    }
  }
}

async function tableHasColumn(
  transaction: Awaited<ReturnType<Client["transaction"]>>,
  table: string,
  column: string,
) {
  const result = await transaction.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => row.name === column);
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
