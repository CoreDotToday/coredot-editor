import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_JOB_RUNNER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "windows-job-runner.ps1",
);

export type PnpmInvocation = {
  command: string;
  prefixArguments: string[];
};

export type ProcessTreeTerminationPlan = {
  arguments: string[];
  command: "taskkill";
};

export type WindowsJobRunnerInvocation = {
  arguments: string[];
  command: "powershell.exe";
};

export type ManagedProcess = {
  child: ChildProcess;
  exit: Promise<ManagedProcessExit>;
  pid: number;
};

export type ManagedProcessExit = {
  code: number | null;
  error: boolean;
  signal: NodeJS.Signals | null;
};

export type ManagedCommandOptions = {
  arguments: string[];
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  forceTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  signal?: AbortSignal;
  timeoutMs: number;
};

export type ManagedCommandOwner = {
  run(options: ManagedCommandOptions): Promise<void>;
  settle(options?: {
    forceTimeoutMs?: number;
    gracefulTimeoutMs?: number;
  }): Promise<void>;
};

export type ManagedProcessOwner = {
  adopt(managed: ManagedProcess): void;
  release(managed: ManagedProcess): void;
  settle(options?: {
    forceTimeoutMs?: number;
    gracefulTimeoutMs?: number;
  }): Promise<void>;
};

const STOP_OPERATIONS = new WeakMap<ManagedProcess, Promise<void>>();

export async function acquireInterruptibleResource<T>(options: {
  acquire: () => Promise<T>;
  adopt: (resource: T) => void;
  dispose: (resource: T) => Promise<unknown>;
  signal: AbortSignal;
}): Promise<T> {
  const resource = await options.acquire();
  if (options.signal.aborted) {
    try {
      await options.dispose(resource);
    } catch {
      throw new Error("Managed resource cleanup failed");
    }
    throw new Error("Managed resource acquisition interrupted");
  }

  try {
    // Abort events cannot interleave with this synchronous adoption callback.
    // Once adopted, the task's single cleanup owner is responsible for it.
    options.adopt(resource);
  } catch {
    try {
      await options.dispose(resource);
    } catch {
      // Preserve one generic acquisition failure regardless of disposal detail.
    }
    throw new Error("Managed resource acquisition failed");
  }
  return resource;
}

export function createProcessTreeTerminationPlan(
  platform: NodeJS.Platform,
  pid: number,
  force: boolean,
): ProcessTreeTerminationPlan {
  if (platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Managed process failed");
  }
  const arguments_ = ["/PID", String(pid), "/T"];
  if (force) arguments_.push("/F");
  return { arguments: arguments_, command: "taskkill" };
}

export function createWindowsJobRunnerInvocation(
  command: string,
  arguments_: string[],
  runnerPath = WINDOWS_JOB_RUNNER_PATH,
): WindowsJobRunnerInvocation {
  if (
    !command ||
    command.includes("\0") ||
    arguments_.some((argument) => argument.includes("\0")) ||
    (!isAbsolute(runnerPath) && !win32.isAbsolute(runnerPath))
  ) {
    throw new Error("Managed process failed");
  }
  const payload = Buffer.from(
    JSON.stringify({
      arguments: arguments_,
      executable: command,
      version: 1,
    }),
    "utf8",
  ).toString("base64");
  return {
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerPath,
      payload,
    ],
    command: "powershell.exe",
  };
}

export async function resolvePnpmInvocation(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nodeExecutable = process.execPath,
): Promise<PnpmInvocation> {
  const candidate = environment.npm_execpath;
  if (
    candidate &&
    !candidate.includes("\0") &&
    !candidate.includes("\n") &&
    !candidate.includes("\r") &&
    (isAbsolute(candidate) || win32.isAbsolute(candidate))
  ) {
    try {
      const canonicalCandidate = await realpath(candidate);
      const stats = await lstat(canonicalCandidate);
      if (
        stats.isFile() &&
        /^pnpm\.(?:c?js|mjs)$/i.test(basename(canonicalCandidate))
      ) {
        return {
          command: nodeExecutable,
          prefixArguments: [canonicalCandidate],
        };
      }
    } catch {
      // A missing or non-regular npm_execpath is not a verified JavaScript CLI.
    }
  }

  if (platform !== "win32") {
    return { command: "pnpm", prefixArguments: [] };
  }
  throw new Error("Managed package runner failed");
}

export function spawnManagedProcess(
  command: string,
  arguments_: string[],
  options: SpawnOptions,
): ManagedProcess {
  const invocation =
    process.platform === "win32"
      ? createWindowsJobRunnerInvocation(command, arguments_)
      : { arguments: arguments_, command };
  const child = spawn(invocation.command, invocation.arguments, {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
    stdio: options.stdio ?? "ignore",
  });
  const exit = observeExit(child);
  if (!child.pid) {
    // Keep the error listener installed so a deferred spawn error cannot become
    // an uncaught EventEmitter error after this synchronous failure is reported.
    void exit;
    throw new Error("Managed process failed");
  }
  return { child, exit, pid: child.pid };
}

export function stopManagedProcess(
  managed: ManagedProcess,
  options: {
    forceTimeoutMs?: number;
    gracefulTimeoutMs?: number;
  } = {},
): Promise<void> {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_500;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  try {
    // Invalid calls must never poison this process owner's retry cache.
    validateTimeout(gracefulTimeoutMs);
    validateTimeout(forceTimeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
  const existing = STOP_OPERATIONS.get(managed);
  if (existing) return existing;
  const operation = stopManagedProcessOnce(managed, {
    forceTimeoutMs,
    gracefulTimeoutMs,
  });
  STOP_OPERATIONS.set(managed, operation);
  void operation.then(undefined, () => {
    if (STOP_OPERATIONS.get(managed) === operation) {
      STOP_OPERATIONS.delete(managed);
    }
  });
  return operation;
}

async function stopManagedProcessOnce(
  managed: ManagedProcess,
  options: {
    forceTimeoutMs: number;
    gracefulTimeoutMs: number;
  },
): Promise<void> {
  signalProcessTree(managed, false, options.gracefulTimeoutMs);
  if (await waitForTreeGone(managed, options.gracefulTimeoutMs)) return;

  signalProcessTree(managed, true, options.forceTimeoutMs);
  if (!(await waitForTreeGone(managed, options.forceTimeoutMs))) {
    throw new Error("Managed process cleanup failed");
  }
}

export async function waitForPortRelease(
  port: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_500;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Managed process cleanup failed");
  }
  validateTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error("Managed process cleanup failed");
    }
    if (await canBindPort(port, options.signal)) return;
    await abortableDelay(25, options.signal);
  }
  throw new Error("Managed process cleanup failed");
}

export function runManagedCommand(options: ManagedCommandOptions): Promise<void> {
  return runManagedCommandOwned(options);
}

export function createManagedCommandOwner(): ManagedCommandOwner {
  const active = new Set<ManagedProcess>();
  let closed = false;
  return {
    run(options) {
      if (closed) {
        return Promise.reject(new Error("Managed command failed"));
      }
      return runManagedCommandOwned(
        options,
        (managed) => active.add(managed),
        (managed) => active.delete(managed),
      );
    },
    async settle(options = {}) {
      closed = true;
      const results = await Promise.allSettled(
        [...active].map((managed) => stopManagedProcess(managed, options)),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Managed process cleanup failed");
      }
    },
  };
}

export function createManagedProcessOwner(): ManagedProcessOwner {
  const active = new Set<ManagedProcess>();
  let closed = false;
  return {
    adopt(managed) {
      if (closed) throw new Error("Managed process failed");
      active.add(managed);
    },
    release(managed) {
      active.delete(managed);
    },
    async settle(options = {}) {
      closed = true;
      const managedProcesses = [...active];
      const results = await Promise.allSettled(
        managedProcesses.map((managed) => stopManagedProcess(managed, options)),
      );
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          active.delete(managedProcesses[index]);
        }
      });
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Managed process cleanup failed");
      }
    },
  };
}

async function runManagedCommandOwned(
  options: ManagedCommandOptions,
  adopt: (managed: ManagedProcess) => unknown = () => undefined,
  release: (managed: ManagedProcess) => unknown = () => undefined,
): Promise<void> {
  validateTimeout(options.timeoutMs);
  const managed = spawnManagedProcess(options.command, options.arguments, {
    cwd: options.cwd,
    env: options.environment,
  });
  adopt(managed);
  let failed = false;
  try {
    const result = await waitForManagedExit(
      managed,
      options.timeoutMs,
      options.signal,
    );
    if (result.error || result.code !== 0 || result.signal !== null) failed = true;
  } catch {
    failed = true;
  } finally {
    let stopped = false;
    try {
      await stopManagedProcess(managed, {
        forceTimeoutMs: options.forceTimeoutMs,
        gracefulTimeoutMs: options.gracefulTimeoutMs,
      });
      stopped = true;
    } catch {
      failed = true;
    }
    // An owner must retain a failed stop so its outer cleanup can retry after
    // the rejected in-flight stop operation has been evicted.
    if (stopped) release(managed);
  }
  if (failed) throw new Error("Managed command failed");
}

type SignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function interruptExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  throw new Error("Managed process failed");
}

export async function runBoundedCleanup(
  steps: readonly ((signal: AbortSignal) => Promise<unknown>)[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  validateTimeout(timeoutMs);
  const controller = new AbortController();
  const operations = steps.map((step) =>
    Promise.resolve().then(() => step(controller.signal)),
  );
  const settled = Promise.allSettled(operations);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([settled, deadline]);
    if (result === "timeout") {
      controller.abort();
      throw new Error("Managed process cleanup failed");
    }
    if (result.some((entry) => entry.status === "rejected")) {
      throw new Error("Managed process cleanup failed");
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runInterruptibleTask<T>(options: {
  cleanup: (signal: AbortSignal) => Promise<unknown>;
  cleanupTimeoutMs?: number;
  execute: (signal: AbortSignal) => Promise<T>;
  signalSource?: SignalSource;
}): Promise<{ signal: NodeJS.Signals } | { value: T }> {
  const source = options.signalSource ?? process;
  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  let resolveInterrupt:
    | ((outcome: { kind: "interrupted"; signal: NodeJS.Signals }) => void)
    | undefined;
  const interruptOutcome = new Promise<{
    kind: "interrupted";
    signal: NodeJS.Signals;
  }>((resolveOutcome) => {
    resolveInterrupt = resolveOutcome;
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanupOnce = () =>
    (cleanupPromise ??= runBoundedCleanup([options.cleanup], {
      timeoutMs: options.cleanupTimeoutMs,
    }));
  const interrupt = (signal: NodeJS.Signals) => {
    if (interruptedBy) return;
    interruptedBy = signal;
    controller.abort();
    // Cleanup owns resources that may be the only way to unblock work which
    // does not cooperate with AbortSignal (for example, a browser operation).
    void cleanupOnce().catch(() => undefined);
    resolveInterrupt?.({ kind: "interrupted", signal });
  };
  const handleSigint = () => interrupt("SIGINT");
  const handleSigterm = () => interrupt("SIGTERM");
  source.once("SIGINT", handleSigint);
  source.once("SIGTERM", handleSigterm);

  let operation: Promise<T>;
  try {
    operation = options.execute(controller.signal);
  } catch (error) {
    operation = Promise.reject(error);
  }
  const operationOutcome = operation.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ error, kind: "rejected" as const }),
  );

  try {
    const first = await Promise.race([operationOutcome, interruptOutcome]);
    try {
      await cleanupOnce();
    } catch {
      throw new Error("Managed process cleanup failed");
    }

    if (interruptedBy) return { signal: interruptedBy };
    if (first.kind === "interrupted") return { signal: first.signal };
    if (first.kind === "rejected") throw first.error;
    return { value: first.value };
  } finally {
    source.removeListener("SIGINT", handleSigint);
    source.removeListener("SIGTERM", handleSigterm);
  }
}

function observeExit(child: ChildProcess): Promise<ManagedProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      error: false,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (result: ManagedProcessExit) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once("error", () =>
      finish({ code: null, error: true, signal: null }),
    );
    child.once("close", (code, signal) =>
      finish({ code, error: false, signal }),
    );
  });
}

function waitForManagedExit(
  managed: ManagedProcess,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    return Promise.reject(new Error("Managed command failed"));
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Managed command failed")),
      timeoutMs,
    );
    timeout.unref();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const handleAbort = () => reject(new Error("Managed command failed"));
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
    if (signal.aborted) handleAbort();
  });
  return Promise.race([managed.exit, deadline, aborted]).finally(() => {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
  });
}

function signalProcessTree(
  managed: ManagedProcess,
  force: boolean,
  timeoutMs: number,
) {
  if (process.platform === "win32") {
    const plan = createProcessTreeTerminationPlan(
      process.platform,
      managed.pid,
      force,
    );
    const result = spawnSync(plan.command, plan.arguments, {
      killSignal: "SIGKILL",
      shell: false,
      stdio: "ignore",
      timeout: timeoutMs,
    });
    if (!result.error && result.status === 0) return;
  } else {
    try {
      process.kill(-managed.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if the process group already disappeared.
    }
  }
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) return;
  try {
    managed.child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may exit between the state check and signal delivery.
  }
}

async function waitForTreeGone(managed: ManagedProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessTreeAlive(managed))) return true;
    await abortableDelay(25);
  }
  return !(await isProcessTreeAlive(managed));
}

async function isProcessTreeAlive(managed: ManagedProcess) {
  if (process.platform === "win32") {
    return (
      managed.child.exitCode === null && managed.child.signalCode === null
    );
  }
  try {
    process.kill(-managed.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canBindPort(port: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new Error("Managed process cleanup failed"));
  }
  return new Promise<boolean>((resolveResult, reject) => {
    const server = createServer();
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      server.removeAllListeners();
    };
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(available);
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        server.close();
      } catch {
        // A not-yet-listening server has no remaining resource to close.
      }
      reject(new Error("Managed process cleanup failed"));
    };
    server.once("error", () => finish(false));
    signal?.addEventListener("abort", handleAbort, { once: true });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => finish(true));
    });
    if (signal?.aborted) handleAbort();
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new Error("Managed process cleanup failed"));
  }
  return new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolveDelay();
    }, milliseconds);
    timeout.unref();
    const handleAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      reject(new Error("Managed process cleanup failed"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function validateTimeout(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Managed process failed");
  }
}
