import type { WorkspaceScope } from "@/features/auth/request-context";
import type { DocumentWorkflowNotificationGateway } from "@/features/documents/document-workflow-notification-outbox";

const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;

type Schedule = (run: () => void, delayMs: number) => () => void;

export class CollaborationWorkflowNotificationWorkerError extends Error {
  override readonly name = "CollaborationWorkflowNotificationWorkerError";

  constructor() {
    super("Collaboration workflow notification worker is unavailable");
  }
}

export function createSidecarWorkflowNotificationGateway(options: {
  publishWorkflowChanged(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ): void | Promise<void>;
}): DocumentWorkflowNotificationGateway {
  return {
    async notifyWorkflowChanged(scope, documentId, generation) {
      try {
        await options.publishWorkflowChanged(scope, documentId, generation);
      } catch {
        throw new CollaborationWorkflowNotificationWorkerError();
      }
    },
  };
}

export function createCollaborationWorkflowNotificationWorker(options: {
  intervalMs?: number;
  reconcile(): void | Promise<void>;
  schedule?: Schedule;
}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_INTERVAL_MS
    || intervalMs > MAX_INTERVAL_MS
  ) {
    throw new CollaborationWorkflowNotificationWorkerError();
  }
  const schedule = options.schedule ?? scheduleTimeout;
  let active = false;
  let ready = false;
  let cancelScheduled: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;

  const run = async () => {
    try {
      await options.reconcile();
      ready = active;
    } catch {
      ready = false;
    } finally {
      if (active) {
        cancelScheduled = schedule(() => {
          cancelScheduled = undefined;
          inFlight = run();
        }, intervalMs);
      }
    }
  };

  return {
    isReady() {
      return active && ready;
    },
    start() {
      if (active) return;
      active = true;
      ready = false;
      inFlight = run();
    },
    async stop() {
      active = false;
      ready = false;
      cancelScheduled?.();
      cancelScheduled = undefined;
      await inFlight?.catch(() => undefined);
    },
  };
}

function scheduleTimeout(run: () => void, delayMs: number) {
  const timeout = setTimeout(run, delayMs);
  timeout.unref?.();
  return () => clearTimeout(timeout);
}
