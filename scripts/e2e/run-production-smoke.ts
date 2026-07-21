import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "../../src/db/url";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commandTimeouts = {
  build: 180_000,
  cleanup: 5_000,
  fetch: 5_000,
  migrate: 60_000,
  readiness: 30_000,
} as const;
const clerkTestCredentials = {
  CLERK_SECRET_KEY: "sk_test_production_smoke",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
} as const;
export const inheritedToolEnvironmentNames = [
  "CI",
  "COMSPEC",
  "GITHUB_ACTIONS",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "Path",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
] as const;
const MAX_SMOKE_RESPONSE_BYTES = 16 * 1024;

type ProductionSmokeEnvironmentOptions = {
  databaseUrl: string;
  port: number;
};

export type ServerExit = {
  code: number | null;
  error: boolean;
  signal: NodeJS.Signals | null;
};

export function createProductionSmokeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  options: ProductionSmokeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  for (const name of inheritedToolEnvironmentNames) {
    const value = baseEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }

  Object.assign(environment, {
    AI_PROVIDER: "stub",
    AUTH_MODE: "clerk",
    CLERK_SIGN_IN_URL: "/sign-in",
    ...clerkTestCredentials,
    DATABASE_URL: options.databaseUrl,
    HOSTNAME: "127.0.0.1",
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NODE_ENV: "production",
    PORT: String(options.port),
  });
  return environment;
}

export async function assertExactJsonResponse(
  response: Response,
  expectedStatus: number,
  expectedBody: Record<string, string>,
  requireNoStore = true,
) {
  const body = await response.text();
  if (
    response.status !== expectedStatus ||
    body !== JSON.stringify(expectedBody) ||
    (requireNoStore && response.headers.get("Cache-Control") !== "no-store")
  ) {
    throw new Error("Production smoke HTTP contract failed");
  }
}

export function assertRedirectResponse(response: Response, expectedPath: string) {
  const location = response.headers.get("Location");
  let pathname: string | undefined;
  let search: string | undefined;
  try {
    const parsed = location ? new URL(location, "http://localhost") : undefined;
    pathname = parsed?.pathname;
    search = parsed?.search;
  } catch {
    // The generic failure below deliberately avoids echoing an unsafe Location.
  }
  if (![307, 308].includes(response.status) || pathname !== expectedPath || search !== "") {
    throw new Error("Production smoke redirect contract failed");
  }
}

export function assertProtectedPageResponse(response: Response) {
  const location = response.headers.get("Location");
  let pathname: string | undefined;
  try {
    pathname = location ? new URL(location, "http://localhost").pathname : undefined;
  } catch {
    // The generic failure below deliberately avoids echoing an unsafe Location.
  }
  if ([302, 303, 307, 308].includes(response.status) && pathname === "/sign-in") return;

  throw new Error("Production smoke protected page contract failed");
}

export async function withPhaseTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Production smoke phase timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function waitForChild(child: ChildProcess): Promise<ServerExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      error: false,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServerExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ code: null, error: true, signal: null }));
    child.once("exit", (code, signal) => finish({ code, error: false, signal }));
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return false;

  if (process.platform === "win32") {
    const arguments_ = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") arguments_.push("/F");
    const result = spawnSync("taskkill", arguments_, {
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: commandTimeouts.cleanup,
    });
    if (!result.error && result.status === 0) return true;
  } else {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child when the process group has already ended.
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch {
    // Cleanup remains best effort after the child has already disappeared.
    return false;
  }
}

export async function stopProcessTree(child: ChildProcess) {
  const parentAlreadyExited = child.exitCode !== null || child.signalCode !== null;
  const signaled = signalProcessTree(child, "SIGTERM");
  if (parentAlreadyExited) {
    if (signaled) {
      await delay(100);
      signalProcessTree(child, "SIGKILL");
    }
    return;
  }

  const graceful = await Promise.race([
    waitForChild(child).then(() => true),
    delay(commandTimeouts.cleanup).then(() => false),
  ]);
  if (graceful) return;

  signalProcessTree(child, "SIGKILL");
  await withPhaseTimeout(
    waitForChild(child),
    commandTimeouts.cleanup,
  );
}

export async function runCleanupSteps(
  steps: Array<() => Promise<unknown>>,
  timeoutMs = commandTimeouts.cleanup * 3,
) {
  let failed = false;
  for (const step of steps) {
    try {
      await withPhaseTimeout(Promise.resolve().then(step), timeoutMs);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Production smoke cleanup failed");
}

export async function runCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  phase: string,
) {
  reportPhase(phase, "running");
  const child = spawn(pnpmCommand, args, {
    cwd: APP_ROOT,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "ignore",
  });
  try {
    const result = await withPhaseTimeout(waitForChild(child), timeoutMs);
    if (result.error || result.code !== 0) {
      throw new Error("Production smoke phase failed");
    }
    reportPhase(phase, "ok");
  } finally {
    await stopProcessTree(child);
  }
}

export async function reserveAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Production smoke port reservation failed"));
        return;
      }
      server.close((error) => {
        if (error) reject(new Error("Production smoke port reservation failed"));
        else resolve(address.port);
      });
    });
  });
}

async function canBindPort(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function waitForPortRelease(port: number) {
  const deadline = Date.now() + commandTimeouts.cleanup;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return;
    await delay(50);
  }
  throw new Error("Production smoke cleanup failed");
}

async function readResponseBody(response: Response, signal: AbortSignal) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readResponseChunk(reader, signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_SMOKE_RESPONSE_BYTES) {
        throw new Error("Production smoke response exceeded its bound");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is best-effort and must not extend the request deadline.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock while best-effort cancellation settles.
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
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Production smoke HTTP request aborted");

  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const handleAbort = () => reject(new Error("Production smoke HTTP request aborted"));
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

export async function fetchSmokeResponse(
  url: string,
  init?: RequestInit,
  timeoutMs: number = commandTimeouts.fetch,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readResponseBody(response, controller.signal);
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
    throw new Error("Production smoke HTTP request failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReadiness(baseUrl: string, serverExit: Promise<ServerExit>) {
  const deadline = Date.now() + commandTimeouts.readiness;
  while (Date.now() < deadline) {
    const attempt = await Promise.race([
      fetchSmokeResponse(`${baseUrl}/api/ready`)
        .then((response) => response.status === 200)
        .catch(() => false),
      serverExit.then(() => {
        throw new Error("Production smoke server exited before readiness");
      }),
    ]);
    if (attempt) return;
    await delay(100);
  }
  throw new Error("Production smoke readiness timed out");
}

async function assertEmptyResponse(
  response: Response,
  expectedStatus: number,
  expectedAllow?: string,
) {
  const body = await response.text();
  if (
    response.status !== expectedStatus ||
    body !== "" ||
    response.headers.get("Cache-Control") !== "no-store" ||
    (expectedAllow !== undefined && response.headers.get("Allow") !== expectedAllow)
  ) {
    throw new Error("Production smoke HTTP contract failed");
  }
}

async function assertProductionHttpContracts(baseUrl: string) {
  await assertExactJsonResponse(
    await fetchSmokeResponse(`${baseUrl}/api/health`),
    200,
    { status: "ok" },
  );
  await assertEmptyResponse(
    await fetchSmokeResponse(`${baseUrl}/api/health`, { method: "HEAD" }),
    200,
  );
  await assertEmptyResponse(
    await fetchSmokeResponse(`${baseUrl}/api/health`, { method: "OPTIONS" }),
    204,
    "GET, HEAD, OPTIONS",
  );
  await assertExactJsonResponse(
    await fetchSmokeResponse(`${baseUrl}/api/ready`),
    200,
    { status: "ready" },
  );
  await assertEmptyResponse(
    await fetchSmokeResponse(`${baseUrl}/api/ready`, { method: "HEAD" }),
    200,
  );
  await assertEmptyResponse(
    await fetchSmokeResponse(`${baseUrl}/api/ready`, { method: "OPTIONS" }),
    204,
    "GET, HEAD, OPTIONS",
  );
  assertRedirectResponse(
    await fetchSmokeResponse(`${baseUrl}/`, { redirect: "manual" }),
    "/documents",
  );
  assertProtectedPageResponse(
    await fetchSmokeResponse(`${baseUrl}/documents`, { redirect: "manual" }),
  );
  await assertExactJsonResponse(
    await fetchSmokeResponse(`${baseUrl}/api/documents`),
    401,
    { error: "Authentication required" },
    false,
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function reportPhase(phase: string, status: "ok" | "running") {
  console.log(JSON.stringify({ phase, status }));
}

export async function runProductionSmoke() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "coredot-production-smoke-"));
  const databaseUrl = `file:${join(temporaryDirectory, "production-smoke.db")}`;
  let port: number | undefined;
  let server: ChildProcess | undefined;

  try {
    port = await reserveAvailablePort();
    const environment = createProductionSmokeEnvironment(process.env, { databaseUrl, port });
    await runCommand(["db:migrate"], environment, commandTimeouts.migrate, "migrate");
    await runCommand(["build"], environment, commandTimeouts.build, "build");

    reportPhase("start", "running");
    server = spawn(pnpmCommand, ["start"], {
      cwd: APP_ROOT,
      detached: process.platform !== "win32",
      env: environment,
      stdio: "ignore",
    });
    const serverExit = waitForChild(server);
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    await waitForReadiness(baseUrl, serverExit);
    reportPhase("start", "ok");

    await withPhaseTimeout(
      assertProductionHttpContracts(baseUrl),
      commandTimeouts.fetch * 10,
    );
    reportPhase("smoke", "ok");
  } finally {
    await runCleanupSteps([
      async () => {
        if (server) await stopProcessTree(server);
      },
      async () => {
        if (port !== undefined) await waitForPortRelease(port);
      },
      async () => {
        await rm(temporaryDirectory, { force: true, recursive: true });
      },
    ]);
  }
}

async function main() {
  try {
    await runProductionSmoke();
    console.log(JSON.stringify({ status: "ok" }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
