import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  createManagedCommandOwner,
  createManagedProcessOwner,
  createProcessTreeTerminationPlan,
  createWindowsJobRunnerInvocation,
  interruptExitCode,
  resolvePnpmInvocation,
  runBoundedCleanup,
  runInterruptibleTask,
  runManagedCommand,
  spawnManagedProcess,
  stopManagedProcess,
  waitForPortRelease,
  type ManagedProcess,
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

  it("builds a shell-free Windows Job Object runner invocation", () => {
    const invocation = createWindowsJobRunnerInvocation(
      "C:\\Program Files\\nodejs\\node.exe",
      ["fixture.mjs", "value with spaces"],
      "C:\\repo\\scripts\\docs\\windows-job-runner.ps1",
    );
    expect(invocation.command).toBe("powershell.exe");
    expect(invocation.arguments.slice(0, -1)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\repo\\scripts\\docs\\windows-job-runner.ps1",
    ]);
    expect(
      JSON.parse(
        Buffer.from(invocation.arguments.at(-1)!, "base64").toString("utf8"),
      ),
    ).toEqual({
      arguments: ["fixture.mjs", "value with spaces"],
      executable: "C:\\Program Files\\nodejs\\node.exe",
      version: 1,
    });
    expect(() =>
      createWindowsJobRunnerInvocation(
        "node\0.exe",
        [],
        "C:\\repo\\scripts\\docs\\windows-job-runner.ps1",
      ),
    ).toThrow(/^Managed process failed$/);
  });

  it("round-trips adversarial argv through the managed command boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "coredot-managed-argv-"));
    const marker = join(root, "argv.json");
    const fixture = resolve(import.meta.dirname, "fixtures/argv-marker.mjs");
    const expected = [
      "",
      "-H",
      "--bootstrap",
      "value with spaces",
      "C:\\path with spaces\\",
      'embedded"quote',
    ];

    try {
      await runManagedCommand({
        arguments: [fixture, marker, ...expected],
        command: process.execPath,
        cwd: import.meta.dirname,
        environment: process.env,
        timeoutMs: 10_000,
      });
      await expect(readFile(marker, "utf8")).resolves.toBe(
        JSON.stringify(expected),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("managed process tree", () => {
  it("validates stop timeouts before caching so a valid retry can succeed", async () => {
    const processError = Object.assign(new Error("gone"), { code: "ESRCH" });
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => {
        throw processError;
      }) as typeof process.kill);
    const managed = {
      child: {
        exitCode: 0,
        kill: vi.fn(),
        signalCode: null,
      } as unknown as ChildProcess,
      exit: new Promise<never>(() => undefined),
      pid: 2_147_483_646,
    } satisfies ManagedProcess;

    try {
      await expect(
        stopManagedProcess(managed, { gracefulTimeoutMs: 0 }),
      ).rejects.toThrow(/^Managed process failed$/);
      await expect(
        stopManagedProcess(managed, {
          forceTimeoutMs: 100,
          gracefulTimeoutMs: 100,
        }),
      ).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates an in-flight stop but evicts a rejected stop for retry",
    async () => {
      let treeAlive = true;
      const processError = Object.assign(new Error("gone"), { code: "ESRCH" });
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          if (signal === 0) {
            if (treeAlive) return true;
            throw processError;
          }
          return true;
        }) as typeof process.kill);
      const managed = {
        child: {
          exitCode: null,
          kill: vi.fn(),
          signalCode: null,
        } as unknown as ChildProcess,
        exit: new Promise<never>(() => undefined),
        pid: 2_147_483_645,
      } satisfies ManagedProcess;

      try {
        const first = stopManagedProcess(managed, {
          forceTimeoutMs: 1,
          gracefulTimeoutMs: 1,
        });
        const duplicate = stopManagedProcess(managed, {
          forceTimeoutMs: 1,
          gracefulTimeoutMs: 1,
        });
        expect(duplicate).toBe(first);
        await expect(first).rejects.toThrow(
          /^Managed process cleanup failed$/,
        );

        treeAlive = false;
        await expect(
          stopManagedProcess(managed, {
            forceTimeoutMs: 100,
            gracefulTimeoutMs: 100,
          }),
        ).resolves.toBeUndefined();
      } finally {
        treeAlive = false;
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains a command whose first stop fails so owner settlement can retry",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coredot-command-retry-"));
      const marker = join(root, "ready.json");
      const port = await reservePort();
      const fixture = resolve(
        import.meta.dirname,
        "fixtures/managed-process-tree.mjs",
      );
      const controller = new AbortController();
      const owner = createManagedCommandOwner();
      let kill: ReturnType<typeof vi.spyOn> | undefined;
      let identities: { leafPid: number; parentPid: number } | undefined;
      const command = owner.run({
        arguments: [fixture, "parent", String(port), marker],
        command: process.execPath,
        cwd: import.meta.dirname,
        environment: process.env,
        forceTimeoutMs: 1,
        gracefulTimeoutMs: 1,
        signal: controller.signal,
        timeoutMs: 30_000,
      });

      try {
        identities = await waitForJson<{
          leafPid: number;
          parentPid: number;
        }>(marker);
        kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
        controller.abort();
        await expect(command).rejects.toThrow(/^Managed command failed$/);
        kill.mockRestore();
        kill = undefined;

        await owner.settle({
          forceTimeoutMs: 2_000,
          gracefulTimeoutMs: 200,
        });
        await waitForPortRelease(port, { timeoutMs: 2_000 });
        expectProcessGone(identities.parentPid);
        expectProcessGone(identities.leafPid);
      } finally {
        kill?.mockRestore();
        controller.abort();
        if (identities) {
          try {
            process.kill(-identities.parentPid, "SIGKILL");
          } catch {
            // The retained owner may already have reaped the whole group.
          }
        }
        await owner
          .settle({ forceTimeoutMs: 2_000, gracefulTimeoutMs: 100 })
          .catch(() => undefined);
        await rm(root, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it(
    "cleans a startup child adopted before readiness after an interrupt",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coredot-startup-owner-"));
      const marker = join(root, "ready.json");
      const openFilePath = join(root, "startup.open");
      const port = await reservePort();
      const fixture = resolve(
        import.meta.dirname,
        "fixtures/managed-process-tree.mjs",
      );
      const source = new EventEmitter();
      const owner = createManagedProcessOwner();
      let identities:
        | { leafPid: number; parentPid: number; port: number }
        | undefined;
      let announceReady: (() => void) | undefined;
      const ready = new Promise<void>((resolveReady) => {
        announceReady = resolveReady;
      });
      const task = runInterruptibleTask({
        cleanup: async (signal) => {
          await owner.settle({
            forceTimeoutMs: 2_000,
            gracefulTimeoutMs: 200,
          });
          await waitForPortRelease(port, { signal, timeoutMs: 2_000 });
          await rm(root, { force: true, recursive: true });
        },
        cleanupTimeoutMs: 8_000,
        execute: async () => {
          const managed = spawnManagedProcess(
            process.execPath,
            [fixture, "parent", String(port), marker, openFilePath],
            { cwd: import.meta.dirname, env: process.env },
          );
          owner.adopt(managed);
          identities = await waitForJson<{
            leafPid: number;
            parentPid: number;
            port: number;
          }>(marker);
          announceReady?.();
          await new Promise<never>(() => undefined);
        },
        signalSource: source,
      });

      try {
        await ready;
        source.emit("SIGTERM");
        await expect(task).resolves.toEqual({ signal: "SIGTERM" });
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        expectProcessGone(identities!.parentPid);
        expectProcessGone(identities!.leafPid);
        await waitForPortRelease(port, { timeoutMs: 2_000 });
      } finally {
        source.emit("SIGTERM");
        await owner
          .settle({ forceTimeoutMs: 2_000, gracefulTimeoutMs: 100 })
          .catch(() => undefined);
        await rm(root, { force: true, recursive: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "proves the detached Windows leaf survives without the custom Job Object",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coredot-windows-control-"));
      const marker = join(root, "ready.json");
      const port = await reservePort();
      const fixture = resolve(
        import.meta.dirname,
        "fixtures/managed-process-tree.mjs",
      );
      const child = spawn(
        process.execPath,
        [fixture, "failing-parent", String(port), marker],
        { cwd: import.meta.dirname, env: process.env, stdio: "ignore" },
      );
      const closed = new Promise<void>((resolveClose, rejectClose) => {
        child.once("error", rejectClose);
        child.once("close", () => resolveClose());
      });
      let leafPid: number | undefined;

      try {
        const identities = await waitForJson<{ leafPid: number }>(marker);
        leafPid = identities.leafPid;
        await closed;
        await expect(
          waitForPortRelease(port, { timeoutMs: 250 }),
        ).rejects.toThrow(/^Managed process cleanup failed$/);
      } finally {
        let cleanupFailed = false;
        try {
          const childIsLive =
            child.exitCode === null && child.signalCode === null;
          if (childIsLive && child.pid) {
            const rootPlan = createProcessTreeTerminationPlan(
              "win32",
              child.pid,
              true,
            );
            const rootCleanup = spawnSync(
              rootPlan.command,
              rootPlan.arguments,
              { shell: false, stdio: "ignore", timeout: 5_000 },
            );
            if (rootCleanup.error || rootCleanup.status !== 0) {
              cleanupFailed = true;
            }
            let closeTimeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                closed,
                new Promise<never>((_resolve, reject) =>
                  (closeTimeout = setTimeout(
                    () => reject(new Error("root cleanup timed out")),
                    5_000,
                  )),
                ),
              ]);
            } catch {
              cleanupFailed = true;
            } finally {
              if (closeTimeout) clearTimeout(closeTimeout);
            }
          } else if (childIsLive) {
            cleanupFailed = true;
            child.kill("SIGKILL");
          }
          if (leafPid) {
            const leafPlan = createProcessTreeTerminationPlan(
              "win32",
              leafPid,
              true,
            );
            const leafCleanup = spawnSync(
              leafPlan.command,
              leafPlan.arguments,
              { shell: false, stdio: "ignore", timeout: 5_000 },
            );
            if (leafCleanup.error || leafCleanup.status !== 0) {
              cleanupFailed = true;
            }
          }
          try {
            await waitForPortRelease(port, { timeoutMs: 5_000 });
          } catch {
            cleanupFailed = true;
          }
          if (leafPid) {
            try {
              expectProcessGone(leafPid);
            } catch {
              cleanupFailed = true;
            }
          }
        } finally {
          try {
            await rm(root, { force: true, recursive: true });
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) throw new Error("Windows fixture cleanup failed");
      }
    },
    15_000,
  );

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
      ).rejects.toThrow(/^Managed (?:command|process) failed$/);
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
      if (process.platform !== "win32") {
        expect(pids.parentPid).toBe(managed.pid);
      }
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

  it(
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
    let announceDisposed: (() => void) | undefined;
    const disposalFinished = new Promise<void>((resolveDisposal) => {
      announceDisposed = resolveDisposal;
    });
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
            announceDisposed?.();
          },
          signal,
        });
      },
      signalSource: source,
    });

    source.emit("SIGTERM");
    await cleanupStarted;
    await expect(task).resolves.toEqual({ signal: "SIGTERM" });
    releaseAcquisition?.({ id: "late-browser" });
    await disposalFinished;
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

  it("returns after bounded cleanup when interrupted work never cooperates", async () => {
    const source = new EventEmitter();
    let announceCleanup: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolveCleanup) => {
      announceCleanup = resolveCleanup;
    });
    const task = runInterruptibleTask({
      cleanup: async () => {
        announceCleanup?.();
      },
      execute: async () => new Promise<never>(() => undefined),
      signalSource: source,
    });

    source.emit("SIGTERM");

    await expect(
      Promise.race([
        cleanupStarted,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("cleanup did not start")), 100),
        ),
      ]),
    ).resolves.toBeUndefined();
    await expect(task).resolves.toEqual({ signal: "SIGTERM" });
  });

  it("handles a rejection that arrives after the interrupted task returned", async () => {
    const source = new EventEmitter();
    const unhandled: unknown[] = [];
    let rejectExecution: ((error: Error) => void) | undefined;
    const monitor = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", monitor);
    const task = runInterruptibleTask({
      cleanup: async () => undefined,
      execute: async () =>
        new Promise<never>((_resolve, reject) => {
          rejectExecution = reject;
        }),
      signalSource: source,
    });

    try {
      source.emit("SIGINT");
      await expect(task).resolves.toEqual({ signal: "SIGINT" });
      rejectExecution?.(new Error("late execution failure"));
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", monitor);
    }
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

  for (const phase of ["migration", "bootstrap"] as const) {
    it.skipIf(process.platform === "win32")(
    `handles SIGTERM during ${phase} without a process, port, file, or temp tail`,
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
        ["--import", "tsx", harness, resultPath, String(port), phase],
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
          openFilePath: string;
          parentPid: number;
          phase: string;
          status: string;
          temporaryRoot: string;
        }>(resultPath, (value) => value.status === "ready");
        expect(child.kill("SIGTERM")).toBe(true);
        await expect(closed).resolves.toEqual({ code: 143, signal: null });
        const cleaned = await waitForJsonMatching<{
          cleanupCount: number;
          leafPid: number;
          openFilePath: string;
          parentPid: number;
          phase: string;
          signal: string;
          status: string;
          temporaryRoot: string;
        }>(resultPath, (value) => value.status === "cleaned");

        expect(cleaned).toMatchObject({
          cleanupCount: 1,
          openFilePath: ready.openFilePath,
          phase,
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
  }
});
