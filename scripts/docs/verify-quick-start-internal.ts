import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCleanupWorkerEnvironment,
  createToolEnvironment,
} from "./verify-quick-start-shared";
import {
  copyDocumentedEnvironmentTemplate,
  copyTrackedWorkingFiles,
} from "./verify-quick-start-snapshot";
import {
  resolvePnpmInvocation as resolveManagedPnpmInvocation,
  type PnpmInvocation,
} from "./managed-process";

export {
  copyDocumentedEnvironmentTemplate,
  copyTrackedWorkingFiles,
  listTrackedWorkingFiles,
} from "./verify-quick-start-snapshot";

const INTERNAL_SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(INTERNAL_SCRIPT_PATH), "../..");
const commandTimeouts = {
  cleanup: 10_000,
  database: 60_000,
  http: 5_000,
  install: 180_000,
  readiness: 60_000,
} as const;
const fixedQuickStartEnvironment = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
  TEST_PRINCIPAL_ID: "test:principal:docs-quick-start",
  TEST_WORKSPACE_ID: "test:workspace:docs-quick-start",
} as const;
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;

type ChildResult = {
  code: number | null;
  error: boolean;
  signal: NodeJS.Signals | null;
};

export async function resolvePnpmInvocation(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nodeExecutable = process.execPath,
): Promise<PnpmInvocation> {
  try {
    return await resolveManagedPnpmInvocation(
      platform,
      environment,
      nodeExecutable,
    );
  } catch {
    throw new Error("Quick-start package runner failed");
  }
}

function validateDatabaseUrl(databaseUrl: string) {
  if (
    !databaseUrl.startsWith("file:") ||
    databaseUrl.includes("\n") ||
    databaseUrl.includes("\r")
  ) {
    throw new Error("Quick-start environment failed");
  }

  const filePath = databaseUrl.slice("file:".length);
  if (!isAbsolute(filePath) && !win32.isAbsolute(filePath)) {
    throw new Error("Quick-start environment failed");
  }
}

function createDatabaseEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  databaseUrl: string,
) {
  validateDatabaseUrl(databaseUrl);
  return {
    ...createToolEnvironment(baseEnvironment),
    ...fixedQuickStartEnvironment,
    DATABASE_URL: databaseUrl,
  } as NodeJS.ProcessEnv;
}

export function createQuickStartEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  options: { databaseUrl: string; port: number },
): NodeJS.ProcessEnv {
  validateDatabaseUrl(options.databaseUrl);
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw new Error("Quick-start environment failed");
  }

  return {
    ...createDatabaseEnvironment(baseEnvironment, options.databaseUrl),
    HOSTNAME: "127.0.0.1",
    PORT: String(options.port),
  };
}

async function readBoundedBody(response: Response, signal?: AbortSignal) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await readResponseChunk(reader, signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
        throw new Error("Quick-start HTTP contract failed");
      }
      chunks.push(result.value);
    }
  } catch {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancelling a failed response is best effort and must not leak its body.
    }
    throw new Error("Quick-start HTTP contract failed");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can briefly retain the lock while cancellation settles.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  if (!signal) return reader.read();
  if (signal.aborted) throw new Error("Quick-start HTTP contract failed");

  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const handleAbort = () =>
      reject(new Error("Quick-start HTTP contract failed"));
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
    if (signal.aborted) handleAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    removeAbortListener?.();
  }
}

export async function assertQuickStartResponse(response: Response): Promise<void> {
  await readBoundedBody(response);
  if (
    response.status >= 200 &&
    response.status < 300
  ) {
    return;
  }
  throw new Error("Quick-start HTTP contract failed");
}

async function assertRootRedirectResponse(response: Response) {
  await readBoundedBody(response);
  if (
    (response.status === 307 || response.status === 308) &&
    response.headers.get("Location") === "/documents"
  ) {
    return;
  }
  throw new Error("Quick-start HTTP contract failed");
}

async function fetchQuickStartResponse(
  url: string,
  init?: RequestInit,
  timeoutMs: number = commandTimeouts.http,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response, controller.signal);
    return new Response(
      [101, 204, 205, 304].includes(response.status) ? null : body,
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      },
    );
  } catch {
    controller.abort();
    throw new Error("Quick-start HTTP request failed");
  } finally {
    clearTimeout(timeout);
  }
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  failureMessage: string,
  options: { unref?: boolean } = {},
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
      if (options.unref) timeout.unref();
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function remainingPhaseTime(deadline: number, failureMessage: string) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(failureMessage);
  return remaining;
}

function waitForChild(
  child: ChildProcess,
  signal?: AbortSignal,
): Promise<ChildResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      error: false,
      signal: child.signalCode,
    });
  }
  if (signal?.aborted) {
    return Promise.reject(new Error("Quick-start cleanup failed"));
  }
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const cleanup = () => {
      child.off("error", handleError);
      child.off("close", handleClose);
      signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (result: ChildResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };
    const handleError = () =>
      finish({ code: null, error: true, signal: null });
    const handleClose = (code: number | null, exitSignal: NodeJS.Signals | null) =>
      finish({ code, error: false, signal: exitSignal });
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Quick-start cleanup failed"));
    };
    child.once("error", handleError);
    child.once("close", handleClose);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return false;

  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const result = spawnSync("taskkill", args, {
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: Math.floor(commandTimeouts.cleanup / 2),
    });
    if (!result.error && result.status === 0) return true;
  } else {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall through when the detached process group has already ended.
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new Error("Quick-start cleanup failed"));
  }
  return new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolveDelay();
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      reject(new Error("Quick-start cleanup failed"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

async function stopProcessTree(child: ChildProcess, signal: AbortSignal) {
  if (signal.aborted) {
    signalProcessTree(child, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await waitForChild(child);
    }
    throw new Error("Quick-start cleanup failed");
  }
  if (!signalProcessTree(child, "SIGTERM")) return;
  const graceDeadline = Math.floor(commandTimeouts.cleanup / 4);
  const graceController = new AbortController();
  let graceExpired = false;
  const handleAbort = () => graceController.abort();
  signal.addEventListener("abort", handleAbort, { once: true });
  const graceTimeout = setTimeout(() => {
    graceExpired = true;
    graceController.abort();
  }, graceDeadline);
  const exitedGracefully = await waitForChild(child, graceController.signal)
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      clearTimeout(graceTimeout);
      signal.removeEventListener("abort", handleAbort);
    });
  if (exitedGracefully) return;

  signalProcessTree(child, "SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await waitForChild(child);
  }
  if (signal.aborted || (!graceExpired && graceController.signal.aborted)) {
    throw new Error("Quick-start cleanup failed");
  }
}

export async function runCleanupWorker(
  arguments_: string[],
  signal: AbortSignal,
  onSpawn?: (pid: number) => void,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (signal.aborted) throw new Error("Quick-start cleanup failed");
  const worker = spawn(process.execPath, arguments_, {
    env: createCleanupWorkerEnvironment(baseEnvironment),
    stdio: "ignore",
  });
  if (worker.pid) onSpawn?.(worker.pid);
  const handleAbort = () => {
    try {
      worker.kill("SIGKILL");
    } catch {
      // The worker may already have exited between the abort and the kill.
    }
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  if (signal.aborted) handleAbort();
  try {
    const result = await waitForChild(worker);
    if (
      signal.aborted ||
      result.error ||
      result.code !== 0
    ) {
      throw new Error("Quick-start cleanup failed");
    }
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
}

async function removeTemporaryDirectory(directory: string, signal: AbortSignal) {
  await runCleanupWorker(
    [
      "-e",
      "require('node:fs/promises').rm(process.argv[1], { force: true, recursive: true }).catch(() => { process.exitCode = 1; });",
      directory,
    ],
    signal,
  );
}

export async function runCleanupSteps(
  steps: Array<(signal: AbortSignal) => Promise<unknown>>,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolveDeadline) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolveDeadline();
    }, commandTimeouts.cleanup);
  });
  const operations = steps.map((step) =>
    Promise.resolve().then(() => step(controller.signal)),
  );
  const settled = Promise.allSettled(operations);
  let results: PromiseSettledResult<unknown>[];
  try {
    await Promise.race([settled, deadline]);
    results = await settled;
  } catch {
    throw new Error("Quick-start cleanup failed");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (
    timedOut ||
    results.some((result) => result.status === "rejected")
  ) {
    throw new Error("Quick-start cleanup failed");
  }
}

async function runPnpmCommand(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  phase: string,
) {
  reportPhase(phase, "running");
  const invocation = await resolvePnpmInvocation();
  const child = spawn(invocation.command, [...invocation.prefixArguments, ...args], {
    cwd,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "ignore",
  });
  try {
    const result = await withDeadline(
      waitForChild(child),
      timeoutMs,
      "Quick-start phase timed out",
    );
    if (result.error || result.code !== 0) {
      throw new Error("Quick-start phase failed");
    }
    reportPhase(phase, "ok");
  } finally {
    await stopProcessTree(child, new AbortController().signal);
  }
}

function findAvailablePortCandidate() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Quick-start port failed")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Quick-start port failed"));
        return;
      }
      server.close((error) => {
        if (error) reject(new Error("Quick-start port failed"));
        else resolvePort(address.port);
      });
    });
  });
}

type QuickStartServerRetryOptions<TServer> = {
  deadline: number;
  findPortCandidate: () => Promise<number>;
  startServer: (port: number) => {
    server: TServer;
    serverExit: Promise<ChildResult>;
  };
  stopServer: (server: TServer) => Promise<void>;
  waitForReady: (
    baseUrl: string,
    serverExit: Promise<ChildResult>,
    deadline: number,
  ) => Promise<void>;
};

export async function startQuickStartServerWithRetry<TServer>(
  options: QuickStartServerRetryOptions<TServer>,
) {
  const maximumAttempts = 3;
  const usedCandidates = new Set<number>();

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let port: number | undefined;
    for (let selection = 0; selection < maximumAttempts * 2; selection += 1) {
      const candidate = await withDeadline(
        options.findPortCandidate(),
        remainingPhaseTime(
          options.deadline,
          "Quick-start readiness timed out",
        ),
        "Quick-start readiness timed out",
      );
      if (
        Number.isInteger(candidate) &&
        candidate >= 1 &&
        candidate <= 65_535 &&
        !usedCandidates.has(candidate)
      ) {
        port = candidate;
        usedCandidates.add(candidate);
        break;
      }
    }
    if (port === undefined) throw new Error("Quick-start server failed");

    remainingPhaseTime(options.deadline, "Quick-start readiness timed out");
    const started = options.startServer(port);
    let serverExited = false;
    void started.serverExit.then(
      () => {
        serverExited = true;
      },
      () => {
        serverExited = true;
      },
    );
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    try {
      await options.waitForReady(
        baseUrl,
        started.serverExit,
        options.deadline,
      );
      return { ...started, baseUrl, port };
    } catch {
      const exitedBeforeStop = serverExited;
      await options.stopServer(started.server);
      if (!exitedBeforeStop || attempt === maximumAttempts - 1) {
        throw new Error("Quick-start server failed");
      }
    }
  }
  throw new Error("Quick-start server failed");
}

function canBindPort(port: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new Error("Quick-start cleanup failed"));
  }
  return new Promise<boolean>((resolveResult, reject) => {
    const server = createServer();
    let settled = false;
    const cleanup = () => {
      server.off("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(available);
    };
    const handleError = () => finish(false);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        server.close();
      } catch {
        // A not-yet-listening server has no resource left to close.
      }
      reject(new Error("Quick-start cleanup failed"));
    };
    server.once("error", handleError);
    signal.addEventListener("abort", handleAbort, { once: true });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => finish(true));
    });
    if (signal.aborted) handleAbort();
  });
}

async function waitForPortRelease(
  port: number,
  signal: AbortSignal,
  timeoutMs = Math.floor(commandTimeouts.cleanup / 4),
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Quick-start cleanup failed");
    if (await canBindPort(port, signal)) return;
    await abortableDelay(50, signal);
  }
  throw new Error("Quick-start cleanup failed");
}

export async function waitForReadiness(
  baseUrl: string,
  serverExit: Promise<ChildResult>,
  deadline = Date.now() + commandTimeouts.readiness,
) {
  while (true) {
    const remaining = remainingPhaseTime(
      deadline,
      "Quick-start readiness timed out",
    );
    const ready = await withDeadline(
      Promise.race([
        fetchQuickStartResponse(
          `${baseUrl}/api/ready`,
          undefined,
          Math.min(commandTimeouts.http, remaining),
        )
          .then(async (response) => {
            const body = await readBoundedBody(response);
            return response.status === 200 && body === '{"status":"ready"}';
          })
          .catch(() => false),
        serverExit.then(() => {
          throw new Error("Quick-start server exited before readiness");
        }),
      ]),
      remaining,
      "Quick-start readiness timed out",
    );
    if (ready) {
      const documentsRemaining = remainingPhaseTime(
        deadline,
        "Quick-start readiness timed out",
      );
      const documentsReady = await withDeadline(
        Promise.race([
          fetchQuickStartResponse(
            `${baseUrl}/documents`,
            { redirect: "manual" },
            Math.min(commandTimeouts.http, documentsRemaining),
          )
            .then(async (response) => {
              await assertQuickStartResponse(response);
              return true;
            })
            .catch(() => false),
          serverExit.then(() => {
            throw new Error("Quick-start server exited before readiness");
          }),
        ]),
        documentsRemaining,
        "Quick-start readiness timed out",
      );
      if (documentsReady) return;
    }
    const pollBudget = deadline - Date.now();
    if (pollBudget <= 0) {
      throw new Error("Quick-start readiness timed out");
    }
    await delay(Math.min(100, pollBudget));
  }
}

export async function assertHttpContracts(baseUrl: string) {
  const deadline = Date.now() + commandTimeouts.http;
  reportPhase("http-root", "running");
  const rootResponse = await fetchQuickStartResponse(
    `${baseUrl}/`,
    { redirect: "manual" },
    remainingPhaseTime(deadline, "Quick-start HTTP request failed"),
  );
  await withDeadline(
    assertRootRedirectResponse(rootResponse),
    remainingPhaseTime(deadline, "Quick-start HTTP contract failed"),
    "Quick-start HTTP contract failed",
  );
  reportPhase("http-root", "ok");

  reportPhase("http-documents", "running");
  const documentsResponse = await fetchQuickStartResponse(
    `${baseUrl}/documents`,
    { redirect: "manual" },
    remainingPhaseTime(deadline, "Quick-start HTTP request failed"),
  );
  await withDeadline(
    assertQuickStartResponse(documentsResponse),
    remainingPhaseTime(deadline, "Quick-start HTTP contract failed"),
    "Quick-start HTTP contract failed",
  );
  reportPhase("http-documents", "ok");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function reportPhase(phase: string, status: "ok" | "running") {
  console.log(JSON.stringify({ phase, status }));
}

export async function runQuickStartVerification() {
  const temporaryRepository = await mkdtemp(
    join(tmpdir(), "coredot-quick-start-repository-"),
  );
  let temporaryDatabaseDirectory: string | undefined;
  let port: number | undefined;
  let server: ChildProcess | undefined;

  try {
    temporaryDatabaseDirectory = await mkdtemp(
      join(tmpdir(), "coredot-quick-start-database-"),
    );
    const databaseUrl = `file:${join(
      temporaryDatabaseDirectory,
      "quick-start.sqlite",
    )}`;

    reportPhase("snapshot", "running");
    await copyTrackedWorkingFiles(APP_ROOT, temporaryRepository);
    reportPhase("snapshot", "ok");

    await runPnpmCommand(
      temporaryRepository,
      ["install", "--frozen-lockfile"],
      createToolEnvironment(process.env),
      commandTimeouts.install,
      "install",
    );

    reportPhase("configure", "running");
    await copyDocumentedEnvironmentTemplate(temporaryRepository);
    reportPhase("configure", "ok");

    await runPnpmCommand(
      temporaryRepository,
      ["db:setup"],
      createDatabaseEnvironment(process.env, databaseUrl),
      commandTimeouts.database,
      "database",
    );

    reportPhase("start", "running");
    const invocation = await resolvePnpmInvocation();
    const startDeadline = Date.now() + commandTimeouts.readiness;
    const started = await startQuickStartServerWithRetry({
      deadline: startDeadline,
      findPortCandidate: findAvailablePortCandidate,
      startServer: (candidate) => {
        const environment = createQuickStartEnvironment(process.env, {
          databaseUrl,
          port: candidate,
        });
        const child = spawn(
          invocation.command,
          [
            ...invocation.prefixArguments,
            "dev",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(candidate),
          ],
          {
            cwd: temporaryRepository,
            detached: process.platform !== "win32",
            env: environment,
            stdio: "ignore",
          },
        );
        return { server: child, serverExit: waitForChild(child) };
      },
      stopServer: async (child) => {
        await stopProcessTree(child, new AbortController().signal);
      },
      waitForReady: waitForReadiness,
    });
    server = started.server;
    port = started.port;
    reportPhase("start", "ok");

    reportPhase("http", "running");
    await assertHttpContracts(started.baseUrl);
    reportPhase("http", "ok");
  } finally {
    reportPhase("cleanup", "running");
    await runCleanupSteps([
      async (signal) => {
        let failed = false;
        for (const step of [
          async () => {
            if (server) await stopProcessTree(server, signal);
          },
          async () => {
            if (port !== undefined) await waitForPortRelease(port, signal);
          },
          async () => {
            await removeTemporaryDirectory(temporaryRepository, signal);
          },
        ]) {
          try {
            await step();
          } catch {
            failed = true;
          }
        }
        if (failed) throw new Error("Quick-start cleanup failed");
      },
      async (signal) => {
        if (temporaryDatabaseDirectory) {
          await removeTemporaryDirectory(temporaryDatabaseDirectory, signal);
        }
      },
    ]);
    reportPhase("cleanup", "ok");
  }
}
