// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationWorkflowNotificationWorker,
  createSidecarWorkflowNotificationGateway,
} from "./workflow-notification-worker";

describe("collaboration workflow notification worker", () => {
  it("publishes the constant server-owned signal to the exact job generation", async () => {
    const publishWorkflowChanged = vi.fn();
    const gateway = createSidecarWorkflowNotificationGateway({ publishWorkflowChanged });

    await gateway.notifyWorkflowChanged(
      { workspaceId: "workspace-a" },
      "document-a",
      3,
    );

    expect(publishWorkflowChanged).toHaveBeenCalledWith(
      { workspaceId: "workspace-a" },
      "document-a",
      3,
    );
  });

  it("bounds sidecar publication failures without reflecting details", async () => {
    const gateway = createSidecarWorkflowNotificationGateway({
      async publishWorkflowChanged() {
        throw new Error("private stateless transport token");
      },
    });

    await expect(gateway.notifyWorkflowChanged(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
    )).rejects.toMatchObject({
      message: "Collaboration workflow notification worker is unavailable",
      name: "CollaborationWorkflowNotificationWorkerError",
    });
    await expect(gateway.notifyWorkflowChanged(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
    )).rejects.not.toThrow("private stateless transport token");
  });

  it("runs immediately without overlap, reports readiness, and recovers", async () => {
    const first = deferred<void>();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("private storage token"))
      .mockResolvedValue(undefined);
    const scheduler = fakeScheduler();
    const worker = createCollaborationWorkflowNotificationWorker({
      intervalMs: 1_000,
      reconcile,
      schedule: scheduler.schedule,
    });

    worker.start();
    worker.start();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(worker.isReady()).toBe(false);
    expect(scheduler.pending()).toBe(0);

    first.resolve();
    await vi.waitFor(() => expect(scheduler.pending()).toBe(1));
    expect(worker.isReady()).toBe(true);
    scheduler.runNext();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.pending()).toBe(1));
    expect(worker.isReady()).toBe(false);
    scheduler.runNext();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(worker.isReady()).toBe(true));
    await worker.stop();
  });

  it("cancels future work and awaits the in-flight reconciliation on stop", async () => {
    const inFlight = deferred<void>();
    const scheduler = fakeScheduler();
    const worker = createCollaborationWorkflowNotificationWorker({
      intervalMs: 1_000,
      reconcile: () => inFlight.promise,
      schedule: scheduler.schedule,
    });
    worker.start();

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    inFlight.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });
});

function fakeScheduler() {
  const tasks: Array<{ active: boolean; run(): void }> = [];
  return {
    pending: () => tasks.filter(({ active }) => active).length,
    runNext() {
      const task = tasks.find(({ active }) => active);
      if (!task) throw new Error("No scheduled task");
      task.active = false;
      task.run();
    },
    schedule(run: () => void) {
      const task = { active: true, run };
      tasks.push(task);
      return () => {
        task.active = false;
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
