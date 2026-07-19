// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationCommandDeliveryWorker,
  createSidecarCommandDeliveryGateway,
} from "./command-delivery-worker";

describe("collaboration command delivery worker", () => {
  it("publishes an exact durable update and bounds sidecar errors", async () => {
    const update = Uint8Array.from([1, 2, 3]);
    const publishDurableUpdate = vi.fn();
    const gateway = createSidecarCommandDeliveryGateway({ publishDurableUpdate });

    await gateway.publishDurableUpdate({ workspaceId: "workspace-a" }, "document-a", 4, update);
    expect(publishDurableUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-a" }, "document-a", 4, update,
    );

    const failedGateway = createSidecarCommandDeliveryGateway({
      async publishDurableUpdate() {
        throw new Error("private sidecar token");
      },
    });
    await expect(failedGateway.publishDurableUpdate(
      { workspaceId: "workspace-a" }, "document-a", 4, update,
    )).rejects.toMatchObject({
      message: "Collaboration command delivery worker is unavailable",
      name: "CollaborationCommandDeliveryWorkerError",
    });
  });

  it("runs immediately without overlap, reports readiness, and recovers", async () => {
    const first = deferred<void>();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("private storage token"))
      .mockResolvedValue(undefined);
    const scheduler = fakeScheduler();
    const worker = createCollaborationCommandDeliveryWorker({
      intervalMs: 1_000,
      reconcile,
      schedule: scheduler.schedule,
    });

    worker.start();
    worker.start();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(worker.isReady()).toBe(false);
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

  it("cancels future work and waits for the in-flight reconciliation", async () => {
    const inFlight = deferred<void>();
    const scheduler = fakeScheduler();
    const worker = createCollaborationCommandDeliveryWorker({
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
