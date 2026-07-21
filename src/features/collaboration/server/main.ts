import { pathToFileURL } from "node:url";

import { createCollaborationAuthorizationRepository } from "../authorization-repository";
import { createCollaborationCommandDeliveryOutbox } from "../command-delivery-outbox";
import { createCollaborationPersistence } from "../persistence";
import { createDocumentArchiveService } from "@/features/documents/document-archive-service";
import { createDocumentWorkflowNotificationOutbox } from "@/features/documents/document-workflow-notification-outbox";
import { createCollaborationSidecar } from "./create-server";
import { readCollaborationServerConfig } from "./config";
import type { CollaborationReadinessChecks } from "./health-server";
import {
  createCollaborationCommandDeliveryWorker,
  createSidecarCommandDeliveryGateway,
} from "./command-delivery-worker";
import {
  createCollaborationRoomClosureWorker,
  createSidecarArchiveRoomGateway,
} from "./room-closure-worker";
import {
  createCollaborationWorkflowNotificationWorker,
  createSidecarWorkflowNotificationGateway,
} from "./workflow-notification-worker";

export const COLLABORATION_MIGRATION_TABLES = [
  "collaboration_documents",
  "collaboration_updates",
  "collaboration_noop_receipts",
  "collaboration_command_delivery_jobs",
  "collaboration_room_closure_jobs",
  "collaboration_workflow_notification_jobs",
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
  stopWorkers(): void | Promise<void>;
}) {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve()
        .then(() => options.stopWorkers())
        .then(() => options.destroySidecar())
        .finally(() => {
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
  const roomClosureWorkerRef: {
    current?: ReturnType<typeof createCollaborationRoomClosureWorker>;
  } = {};
  const workflowNotificationWorkerRef: {
    current?: ReturnType<typeof createCollaborationWorkflowNotificationWorker>;
  } = {};
  const commandDeliveryWorkerRef: {
    current?: ReturnType<typeof createCollaborationCommandDeliveryWorker>;
  } = {};
  const sidecar = createCollaborationSidecar({
    authorization,
    config,
    persistence,
    readinessChecks: createCollaborationReadinessChecks({
      execute: (statement) => sqliteClient.execute(statement),
      workersReady: () => Boolean(
        roomClosureWorkerRef.current?.isReady()
        && workflowNotificationWorkerRef.current?.isReady()
        && commandDeliveryWorkerRef.current?.isReady()
      ),
    }),
  });
  const archiveService = createDocumentArchiveService({
    database: db,
    gateway: createSidecarArchiveRoomGateway({
      closeRoom: (room, reason) => sidecar.closeRoom(room, reason),
    }),
  });
  const roomClosureWorker = createCollaborationRoomClosureWorker({
    async reconcile() {
      await archiveService.reconcileDueRoomClosures();
    },
  });
  roomClosureWorkerRef.current = roomClosureWorker;
  const workflowNotificationOutbox = createDocumentWorkflowNotificationOutbox({
    database: db,
    gateway: createSidecarWorkflowNotificationGateway({
      publishWorkflowChanged: (scope, documentId, generation) =>
        sidecar.publishWorkflowChanged(scope, documentId, generation),
    }),
  });
  const workflowNotificationWorker = createCollaborationWorkflowNotificationWorker({
    async reconcile() {
      await workflowNotificationOutbox.reconcileDue();
    },
  });
  workflowNotificationWorkerRef.current = workflowNotificationWorker;
  const commandDeliveryOutbox = createCollaborationCommandDeliveryOutbox({
    database: db,
    gateway: createSidecarCommandDeliveryGateway({
      publishDurableUpdate: (scope, documentId, generation, update) =>
        sidecar.publishDurableUpdate(scope, documentId, generation, update),
    }),
  });
  const commandDeliveryWorker = createCollaborationCommandDeliveryWorker({
    async reconcile() {
      await commandDeliveryOutbox.reconcileDue();
    },
  });
  commandDeliveryWorkerRef.current = commandDeliveryWorker;

  const shutdown = createCollaborationShutdown({
    closeDatabase: () => sqliteClient.close(),
    destroySidecar: () => sidecar.destroy(),
    stopWorkers: () => Promise.all([
      roomClosureWorker.stop(),
      workflowNotificationWorker.stop(),
      commandDeliveryWorker.stop(),
    ]).then(() => undefined),
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
    roomClosureWorker.start();
    workflowNotificationWorker.start();
    commandDeliveryWorker.start();
  } catch (error) {
    removeSignalHandlers();
    await Promise.all([
      roomClosureWorker.stop(),
      workflowNotificationWorker.stop(),
      commandDeliveryWorker.stop(),
    ]);
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
