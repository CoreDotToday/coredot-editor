import type { WorkspaceScope } from "@/features/auth/request-context";
import type { CollaborationCommandDeliveryGateway } from "@/features/collaboration/command-delivery-outbox";

const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;

type Schedule = (run: () => void, delayMs: number) => () => void;

export class CollaborationCommandDeliveryWorkerError extends Error {
  override readonly name = "CollaborationCommandDeliveryWorkerError";

  constructor() {
    super("Collaboration command delivery worker is unavailable");
  }
}

export function createSidecarCommandDeliveryGateway(options: {
  publishDurableUpdate(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
    update: Uint8Array,
  ): void | Promise<void>;
}): CollaborationCommandDeliveryGateway {
  return {
    async publishDurableUpdate(scope, documentId, generation, update) {
      try {
        await options.publishDurableUpdate(scope, documentId, generation, update);
      } catch {
        throw new CollaborationCommandDeliveryWorkerError();
      }
    },
  };
}

export function createCollaborationCommandDeliveryWorker(options: {
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
    throw new CollaborationCommandDeliveryWorkerError();
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
