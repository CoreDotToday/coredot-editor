import { describe, expect, it, vi } from "vitest";

import { createCollaborationSessionStore } from "./session-store";
import {
  DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS,
  deferCollaborationResourceCleanup,
  type DeferredCleanupTimerApi,
} from "./deferred-resource-cleanup";

const checksum = "a".repeat(64);

describe("deferred collaboration resource cleanup", () => {
  it("cleans acknowledged resources immediately without scheduling a timeout", () => {
    const store = createCollaborationSessionStore();
    const cleanup = vi.fn();
    const timers = createTimers();

    deferCollaborationResourceCleanup({ cleanup, onTimeout: vi.fn(), store, timers });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(timers.pending()).toEqual([]);
  });

  it("keeps resources alive until every pending update receives a durable acknowledgement", () => {
    const store = createCollaborationSessionStore();
    store.recordLocalUpdate(checksum);
    const cleanup = vi.fn();
    const onTimeout = vi.fn();
    const timers = createTimers();

    deferCollaborationResourceCleanup({ cleanup, onTimeout, store, timers });
    expect(cleanup).not.toHaveBeenCalled();
    expect(timers.pending().map((timer) => timer.delay)).toEqual([
      DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS,
    ]);

    store.markAwaitingDurableAcknowledgement(checksum);
    expect(cleanup).not.toHaveBeenCalled();
    store.acknowledgeDurableUpdate(checksum);
    expect(cleanup).not.toHaveBeenCalled();

    timers.runByDelay(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([]);
  });

  it("bounds unhashed pending work, reports the timeout, and still cleans exactly once", () => {
    const store = createCollaborationSessionStore();
    store.beginLocalUpdate();
    const cleanup = vi.fn();
    const onTimeout = vi.fn();
    const timers = createTimers();

    deferCollaborationResourceCleanup({ cleanup, onTimeout, store, timers });
    timers.runByDelay(DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS);
    timers.runAll();

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(timers.pending()).toEqual([]);
  });

  it("does not leak resources when the timeout warning callback throws", () => {
    const store = createCollaborationSessionStore();
    store.recordLocalUpdate(checksum);
    const cleanup = vi.fn();
    const timers = createTimers();

    deferCollaborationResourceCleanup({
      cleanup,
      onTimeout() {
        throw new Error("warning sink unavailable");
      },
      store,
      timers,
    });

    expect(() => timers.runByDelay(DEFERRED_COLLABORATION_CLEANUP_TIMEOUT_MS))
      .not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(timers.pending()).toEqual([]);
  });
});

function createTimers() {
  type Timer = { callback: () => void; delay: number; handle: symbol };
  const scheduled: Timer[] = [];
  const timers = {
    clear(handle: unknown) {
      const timer = scheduled.find((entry) => entry.handle === handle);
      if (timer) scheduled.splice(scheduled.indexOf(timer), 1);
    },
    pending: () => [...scheduled],
    runAll() {
      for (const timer of [...scheduled]) {
        timers.clear(timer.handle);
        timer.callback();
      }
    },
    runByDelay(delay: number) {
      const timer = scheduled.find((entry) => entry.delay === delay);
      if (!timer) throw new Error(`Missing timer with delay ${delay}`);
      timers.clear(timer.handle);
      timer.callback();
    },
    set(callback: () => void, delay: number) {
      const handle = Symbol(`timer-${delay}`);
      scheduled.push({ callback, delay, handle });
      return handle;
    },
  } satisfies DeferredCleanupTimerApi & {
    pending(): Timer[];
    runAll(): void;
    runByDelay(delay: number): void;
  };
  return timers;
}
