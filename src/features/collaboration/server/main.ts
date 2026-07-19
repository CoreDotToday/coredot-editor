import { pathToFileURL } from "node:url";

import { createCollaborationAuthorizationRepository } from "../authorization-repository";
import { createCollaborationPersistence } from "../persistence";
import { createCollaborationSidecar } from "./create-server";
import { readCollaborationServerConfig } from "./config";
import type { CollaborationReadinessChecks } from "./health-server";

export const COLLABORATION_MIGRATION_TABLES = [
  "collaboration_documents",
  "collaboration_updates",
  "collaboration_noop_receipts",
  "collaboration_actions",
  "collaboration_authorization_epochs",
  "document_approvals",
  "collaboration_proposal_anchors",
  "collaboration_document_changes",
  "collaboration_ai_run_snapshots",
] as const;

type ReadinessStatement = string | { args: string[]; sql: string };
type ReadinessExecutor = {
  execute(statement: ReadinessStatement): PromiseLike<{
    rows: readonly unknown[];
  }>;
};

type SignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function createCollaborationReadinessChecks(options: {
  execute: ReadinessExecutor["execute"];
  workersReady(): boolean | Promise<boolean>;
}): CollaborationReadinessChecks {
  return {
    async database() {
      try {
        const result = await options.execute("SELECT 1 AS ok");
        return result.rows.length === 1;
      } catch {
        return false;
      }
    },

    async migration() {
      try {
        const placeholders = COLLABORATION_MIGRATION_TABLES.map(() => "?").join(", ");
        const result = await options.execute({
          args: [...COLLABORATION_MIGRATION_TABLES],
          sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
        });
        const found = new Set(result.rows.flatMap((row) => {
          if (!row || typeof row !== "object" || !("name" in row)) return [];
          const name = row.name;
          return typeof name === "string" ? [name] : [];
        }));
        return COLLABORATION_MIGRATION_TABLES.every((table) => found.has(table));
      } catch {
        return false;
      }
    },

    async workers() {
      try {
        return await options.workersReady() === true;
      } catch {
        return false;
      }
    },
  };
}

export function installCollaborationSignalHandlers(options: {
  onFailure(): void;
  shutdown(): void | Promise<void>;
  signals: SignalSource;
}) {
  let shutdownPromise: Promise<void> | undefined;
  const handleSignal = () => {
    if (shutdownPromise) return;
    try {
      shutdownPromise = Promise.resolve(options.shutdown());
    } catch (error) {
      shutdownPromise = Promise.reject(error);
    }
    void shutdownPromise.catch(() => options.onFailure());
  };
  options.signals.once("SIGINT", handleSignal);
  options.signals.once("SIGTERM", handleSignal);
  return () => {
    options.signals.removeListener("SIGINT", handleSignal);
    options.signals.removeListener("SIGTERM", handleSignal);
  };
}

export function createCollaborationShutdown(options: {
  closeDatabase(): void;
  destroySidecar(): Promise<void>;
  stopWorkers(): void;
}) {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (!shutdownPromise) {
      options.stopWorkers();
      shutdownPromise = options.destroySidecar().finally(() => {
        options.closeDatabase();
      });
    }
    return shutdownPromise;
  };
}

export async function startCollaborationSidecar(
  env: Record<string, string | undefined> = process.env,
) {
  // Configuration parsing validates the public verification key ring before any
  // listener becomes reachable. Private signing material is rejected by config.
  const config = readCollaborationServerConfig(env);
  const { db, sqliteClient } = await import("@/db/client");
  const persistence = createCollaborationPersistence(db);
  const authorization = createCollaborationAuthorizationRepository(db);
  let workersRunning = true;
  const sidecar = createCollaborationSidecar({
    authorization,
    config,
    persistence,
    readinessChecks: createCollaborationReadinessChecks({
      execute: (statement) => sqliteClient.execute(statement),
      // Persistence, checkpoint, and projection work is request-bound in this
      // process today; the lifecycle flag fences it before drain starts.
      workersReady: () => workersRunning,
    }),
  });

  const shutdown = createCollaborationShutdown({
    closeDatabase: () => sqliteClient.close(),
    destroySidecar: () => sidecar.destroy(),
    stopWorkers: () => {
      workersRunning = false;
    },
  });
  const removeSignalHandlers = installCollaborationSignalHandlers({
    onFailure() {
      console.error("Collaboration sidecar shutdown failed");
      process.exitCode = 1;
    },
    shutdown,
    signals: process,
  });

  try {
    await sidecar.listen();
  } catch (error) {
    removeSignalHandlers();
    workersRunning = false;
    sqliteClient.close();
    throw error;
  }

  return {
    httpUrl: sidecar.httpUrl,
    removeSignalHandlers,
    shutdown,
    webSocketUrl: sidecar.webSocketUrl,
  };
}

async function main() {
  const runtime = await startCollaborationSidecar();
  console.log(JSON.stringify({ httpUrl: runtime.httpUrl, status: "listening" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("Collaboration sidecar failed to start");
    process.exitCode = 1;
  });
}
