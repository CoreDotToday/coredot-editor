import { createCollaborationRoomName } from "@/features/collaboration/room-name";
import type { DocumentArchiveRoomGateway } from "@/features/documents/document-archive-service";

const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;

type Schedule = (run: () => void, delayMs: number) => () => void;

export class CollaborationRoomClosureWorkerError extends Error {
  override readonly name = "CollaborationRoomClosureWorkerError";

  constructor() {
    super("Collaboration room closure worker is unavailable");
  }
}

export function createSidecarArchiveRoomGateway(options: {
  closeRoom(
    room: string,
    reason: "archived",
  ): void | Promise<void>;
}): DocumentArchiveRoomGateway {
  return {
    async closeArchivedRoom(scope, documentId, generation) {
      try {
        await options.closeRoom(
          createCollaborationRoomName({
            documentId,
            generation,
            workspaceId: scope.workspaceId,
          }),
          "archived",
        );
      } catch {
        throw new CollaborationRoomClosureWorkerError();
      }
    },
  };
}

export function createCollaborationRoomClosureWorker(options: {
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
    throw new CollaborationRoomClosureWorkerError();
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
