// @vitest-environment node

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  COLLABORATION_MIGRATION_TABLES,
  createCollaborationReadinessChecks,
  installCollaborationSignalHandlers,
} from "./main";

describe("collaboration sidecar production wiring", () => {
  it("requires a non-destructive database probe and every collaboration table", async () => {
    const execute = vi.fn(async (statement: string | { args: unknown[]; sql: string }) => {
      if (typeof statement === "string") return { rows: [{ ok: 1 }] };
      return { rows: COLLABORATION_MIGRATION_TABLES.map((name) => ({ name })) };
    });
    const checks = createCollaborationReadinessChecks({
      execute,
      workersReady: () => true,
    });

    await expect(checks.database()).resolves.toBe(true);
    await expect(checks.migration()).resolves.toBe(true);
    await expect(checks.workers()).resolves.toBe(true);
    expect(execute).toHaveBeenNthCalledWith(1, "SELECT 1 AS ok");
    expect(execute).toHaveBeenNthCalledWith(2, {
      args: [...COLLABORATION_MIGRATION_TABLES],
      sql: expect.stringContaining("sqlite_master"),
    });
  });

  it("fails readiness on an incomplete migration, storage failure, or stopped workers", async () => {
    const incomplete = createCollaborationReadinessChecks({
      execute: async (statement) => typeof statement === "string"
        ? { rows: [] }
        : { rows: COLLABORATION_MIGRATION_TABLES.slice(1).map((name) => ({ name })) },
      workersReady: () => false,
    });

    await expect(incomplete.database()).resolves.toBe(false);
    await expect(incomplete.migration()).resolves.toBe(false);
    await expect(incomplete.workers()).resolves.toBe(false);

    const unavailable = createCollaborationReadinessChecks({
      execute: async () => {
        throw new Error("sensitive storage error");
      },
      workersReady: () => {
        throw new Error("sensitive worker error");
      },
    });
    await expect(unavailable.database()).resolves.toBe(false);
    await expect(unavailable.migration()).resolves.toBe(false);
    await expect(unavailable.workers()).resolves.toBe(false);
  });

  it("runs one graceful shutdown for repeated termination signals and removes handlers", async () => {
    const signals = new EventEmitter();
    const shutdown = vi.fn(async () => undefined);
    const onFailure = vi.fn();
    const remove = installCollaborationSignalHandlers({ onFailure, shutdown, signals });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(onFailure).not.toHaveBeenCalled();

    remove();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
