import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireInterruptibleResource,
  createProcessTreeTerminationPlan,
  interruptExitCode,
  resolvePnpmInvocation,
  runBoundedCleanup,
  runInterruptibleTask,
  runManagedCommand,
  spawnManagedProcess,
  stopManagedProcess,
  waitForPortRelease,
} from "./managed-process";

async function reservePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForJson<T>(path: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("fixture did not become ready");
}

async function waitForJsonMatching<T>(
  path: string,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      if (predicate(value)) return value;
    } catch {
      // The writer may not have published its next state yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("fixture did not publish expected state");
}

function expectProcessGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("managed package runner", () => {
  it("uses Node with a verified JavaScript pnpm CLI on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "coredot-managed-pnpm-"));
    const cli = join(root, "pnpm.cjs");
    await writeFile(cli, "// safe fixture\n", "utf8");

    try {
      await expect(
        resolvePnpmInvocation(
          "win32",
          { npm_execpath: cli },
          "C:\\Program Files\\nodejs\\node.exe",
        ),
      ).resolves.toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        prefixArguments: [await realpath(cli)],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an unverified Windows package runner", async () => {
    await expect(
      resolvePnpmInvocation(
        "win32",
        { npm_execpath: "pnpm.cmd" },
        "C:\\Program Files\\nodejs\\node.exe",
      ),
    ).rejects.toThrow(/^Managed package runner failed$/);
  });

  it("builds a shell-free Windows taskkill tree plan with a force fallback", () => {
    expect(createProcessTreeTerminationPlan("win32", 43123, false)).toEqual({
      arguments: ["/PID", "43123", "/T"],
      command: "taskkill",
    });
    expect(createProcessTreeTerminationPlan("win32", 43123, true)).toEqual({
      arguments: ["/PID", "43123", "/T", "/F"],
      command: "taskkill",
    });
    expect(() => createProcessTreeTerminationPlan("win32", -1, true)).toThrow(
      /^Managed process failed$/,
    );
  });
});

describe("managed process tree", () => {
  it("reports a spawn failure without an unhandled child-process error", async () => {
    const monitoredErrors: unknown[] = [];
    const monitor = (error: unknown) => monitoredErrors.push(error);
    process.on("uncaughtExceptionMonitor", monitor);

    try {
      await expect(
        runManagedCommand({
          arguments: [],
          command: join(
            tmpdir(),
            `coredot-command-that-does-not-exist-${process.pid}`,
          ),
          cwd: import.meta.dirname,
          environment: process.env,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/^Managed process failed$/);
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      expect(monitoredErrors).toEqual([]);
    } finally {
      process.removeListener("uncaughtExceptionMonitor", monitor);
    }
  });

  it("terminates an owned parent and leaf, then proves the port is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "coredot-managed-tree-"));
    const marker = join(root, "ready.json");
    const port = await reservePort();
    const fixture = resolve(
      import.meta.dirname,
      "fixtures/managed-process-tree.mjs",
    );
    const managed = spawnManagedProcess(
      process.execPath,
      [fixture, "parent", String(port), marker],
      { cwd: import.meta.dirname, env: process.env },
    );

    try {
      const pids = await waitForJson<{
        leafPid: number;
        parentPid: number;
        port: number;
      }>(marker);
      expect(pids.parentPid).toBe(managed.pid);
      expect(pids.port).toBe(port);

      await stopManagedProcess(managed, {
        forceTimeoutMs: 2_000,
        gracefulTimeoutMs: 200,
      });
      await waitForPortRelease(port, { timeoutMs: 2_000 });

      expectProcessGone(pids.parentPid);
      expectProcessGone(pids.leafPid);
    } finally {
      await stopManagedProcess(managed, {
        forceTimeoutMs: 2_000,
        gracefulTimeoutMs: 100,
      }).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "cleans the process tree after a direct command exits nonzero",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coredot-managed-failure-"));
      const marker = join(root, "ready.json");
      const port = await reservePort();
      const fixture = resolve(
        import.meta.dirname,
        "fixtures/managed-process-tree.mjs",
      );

      try {
        await expect(
          runManagedCommand({
            arguments: [fixture, "failing-parent", String(port), marker],
            command: process.execPath,
            cwd: import.meta.dirname,
            environment: process.env,
            forceTimeoutMs: 2_000,
            gracefulTimeoutMs: 200,
            timeoutMs: 5_000,
          }),
        ).rejects.toThrow(/^Managed command failed$/);
        const pids = await waitForJson<{ leafPid: number; parentPid: number }>(
          marker,
        );
        await waitForPortRelease(port, { timeoutMs: 2_000 });
        expectProcessGone(pids.parentPid);
        expectProcessGone(pids.leafPid);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    10_000,
  );
});

describe("interruptible task lifecycle", () => {
  it("disposes a resource that resolves after interrupt cleanup already started", async () => {
    const source = new EventEmitter();
    let adopted: { id: string } | undefined;
    let releaseAcquisition: ((resource: { id: string }) => void) | undefined;
    let announceCleanup: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolveCleanup) => {
      announceCleanup = resolveCleanup;
    });
    const disposed: string[] = [];
    const task = runInterruptibleTask({
      cleanup: async () => {
        announceCleanup?.();
        if (adopted) disposed.push(adopted.id);
      },
      execute: async (signal) => {
        await acquireInterruptibleResource({
          acquire: () =>
            new Promise<{ id: string }>((resolveAcquisition) => {
              releaseAcquisition = resolveAcquisition;
            }),
          adopt: (resource) => {
            adopted = resource;
          },
          dispose: async (resource) => {
            disposed.push(resource.id);
          },
          signal,
        });
      },
      signalSource: source,
    });

    source.emit("SIGTERM");
    await cleanupStarted;
    releaseAcquisition?.({ id: "late-browser" });

    await expect(task).resolves.toEqual({ signal: "SIGTERM" });
    expect(adopted).toBeUndefined();
    expect(disposed).toEqual(["late-browser"]);
  });

  it("maps handled interrupt signals to conventional deferred exit codes", () => {
    expect(interruptExitCode("SIGINT")).toBe(130);
    expect(interruptExitCode("SIGTERM")).toBe(143);
  });

  it("lets the first signal abort work and runs the single cleanup owner once", async () => {
    const source = new EventEmitter();
    let cleanupCount = 0;
    const task = runInterruptibleTask({
      cleanup: async () => {
        cleanupCount += 1;
      },
      execute: async (signal) => {
        await new Promise<void>((resolveAbort) =>
          signal.addEventListener("abort", () => resolveAbort(), { once: true }),
        );
        throw new Error("operation aborted");
      },
      signalSource: source,
    });

    source.emit("SIGINT");
    source.emit("SIGTERM");

    await expect(task).resolves.toEqual({ signal: "SIGINT" });
    expect(cleanupCount).toBe(1);
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("starts cleanup immediately when interrupted work ignores AbortSignal", async () => {
    const source = new EventEmitter();
    let releaseExecution: (() => void) | undefined;
    let announceCleanup: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolveCleanup) => {
      announceCleanup = resolveCleanup;
    });
    const task = runInterruptibleTask({
      cleanup: async () => {
        announceCleanup?.();
        releaseExecution?.();
      },
      execute: async () =>
        new Promise<void>((resolveExecution) => {
          releaseExecution = resolveExecution;
        }),
      signalSource: source,
    });

    source.emit("SIGTERM");

    try {
      await expect(
        Promise.race([
          cleanupStarted,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("cleanup did not start")), 100),
          ),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      releaseExecution?.();
      await task.catch(() => undefined);
    }
    expect(await task).toEqual({ signal: "SIGTERM" });
  });

  it("uses one absolute cleanup deadline without awaiting an uncooperative loser", async () => {
    vi.useFakeTimers();
    let fastStepRan = false;
    const pending = runBoundedCleanup(
      [
        async () => new Promise<never>(() => undefined),
        async () => {
          fastStepRan = true;
        },
      ],
      { timeoutMs: 1_000 },
    );

    try {
      const expectation = expect(pending).rejects.toThrow(
        /^Managed process cleanup failed$/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expectation;
      expect(fastStepRan).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === "win32")(
    "handles a real SIGTERM without leaving a process, port, or temp-directory tail",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coredot-interrupt-test-"));
      const resultPath = join(root, "result.json");
      const port = await reservePort();
      const harness = resolve(
        import.meta.dirname,
        "fixtures/interruptible-task-harness.ts",
      );
      const child = spawn(
        process.execPath,
        ["--import", "tsx", harness, resultPath, String(port)],
        {
        cwd: resolve(import.meta.dirname, "../.."),
        stdio: "ignore",
        },
      );
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveClose, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveClose({ code, signal }));
      });

      try {
        const ready = await waitForJsonMatching<{
          leafPid: number;
          parentPid: number;
          status: string;
          temporaryRoot: string;
        }>(resultPath, (value) => value.status === "ready");
        expect(child.kill("SIGTERM")).toBe(true);
        await expect(closed).resolves.toEqual({ code: 143, signal: null });
        const cleaned = await waitForJsonMatching<{
          cleanupCount: number;
          leafPid: number;
          parentPid: number;
          signal: string;
          status: string;
          temporaryRoot: string;
        }>(resultPath, (value) => value.status === "cleaned");

        expect(cleaned).toMatchObject({
          cleanupCount: 1,
          signal: "SIGTERM",
          status: "cleaned",
          temporaryRoot: ready.temporaryRoot,
        });
        await expect(stat(ready.temporaryRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expectProcessGone(cleaned.parentPid);
        expectProcessGone(cleaned.leafPid);
        await waitForPortRelease(port, { timeoutMs: 2_000 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closed.catch(() => undefined);
        }
        await rm(root, { force: true, recursive: true });
      }
    },
    20_000,
  );
});
