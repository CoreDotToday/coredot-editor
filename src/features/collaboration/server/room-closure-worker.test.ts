// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationRoomClosureWorker,
  createSidecarArchiveRoomGateway,
} from "./room-closure-worker";

describe("collaboration room closure worker", () => {
  it("closes the exact generation carried by the durable archive job", async () => {
    const closeRoom = vi.fn();
    const gateway = createSidecarArchiveRoomGateway({ closeRoom });

    await gateway.closeArchivedRoom(
      { workspaceId: "workspace-a" },
      "document-a",
      3,
    );

    expect(closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g3",
      "archived",
    );
  });

  it("bounds room-close failures without exposing their details", async () => {
    const closeFailure = createSidecarArchiveRoomGateway({
      closeRoom: async () => {
        throw new Error("private connection token");
      },
    });
    await expect(closeFailure.closeArchivedRoom(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
    )).rejects.toMatchObject({
      message: "Collaboration room closure worker is unavailable",
      name: "CollaborationRoomClosureWorkerError",
    });
    await expect(closeFailure.closeArchivedRoom(
      { workspaceId: "workspace-a" },
      "document-a",
      1,
    )).rejects.not.toThrow("private connection token");
  });

  it("runs immediately without overlap, reports readiness, and recovers after failure", async () => {
    const first = deferred<void>();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("sensitive storage failure"))
      .mockResolvedValue(undefined);
    const scheduler = fakeScheduler();
    const worker = createCollaborationRoomClosureWorker({
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

  it("cancels future work and waits for the in-flight reconciliation before stopping", async () => {
    const inFlight = deferred<void>();
    const scheduler = fakeScheduler();
    const worker = createCollaborationRoomClosureWorker({
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
    expect(worker.isReady()).toBe(false);

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
