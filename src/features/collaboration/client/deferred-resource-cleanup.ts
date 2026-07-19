import type { CollaborationSessionStore } from "./session-store";
import { hasPendingCollaborationUpdates } from "./durability-state";

export const DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS = 10_000;

export type DeferredCleanupTimerApi = {
  clear(handle: unknown): void;
  set(callback: () => void, delay: number): unknown;
};

const defaultTimers: DeferredCleanupTimerApi = {
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  set: (callback, delay) => setTimeout(callback, delay),
};

export function deferCollaborationResourceCleanup(options: {
  cleanup(): void;
  onTimeout(): void;
  store: Pick<CollaborationSessionStore, "getSnapshot" | "subscribe">;
  timers?: DeferredCleanupTimerApi;
}): void {
  if (!hasPendingCollaborationUpdates(options.store.getSnapshot())) {
    options.cleanup();
    return;
  }

  const timers = options.timers ?? defaultTimers;
  let finalized = false;
  let settleHandle: unknown;
  let unsubscribe: () => void = () => undefined;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    unsubscribe();
    if (settleHandle !== undefined) timers.clear(settleHandle);
    if (timeoutHandle !== undefined) timers.clear(timeoutHandle);
    options.cleanup();
  };

  const scheduleAcknowledgedCleanup = () => {
    if (finalized || settleHandle !== undefined) return;
    settleHandle = timers.set(finalize, 0);
  };

  unsubscribe = options.store.subscribe(() => {
    if (!hasPendingCollaborationUpdates(options.store.getSnapshot())) {
      scheduleAcknowledgedCleanup();
    }
  });
  const timeoutHandle = timers.set(() => {
    try {
      options.onTimeout();
    } catch {
      // Warning delivery must not turn bounded cleanup into an uncaught task.
    } finally {
      finalize();
    }
  }, DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS);

  // Close the subscribe/check race without destroying synchronously from a
  // store publication callback. The zero-delay task avoids adapter re-entry.
  if (!hasPendingCollaborationUpdates(options.store.getSnapshot())) {
    scheduleAcknowledgedCleanup();
  }
}
