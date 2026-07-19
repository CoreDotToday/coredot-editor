import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { exportJWK, generateKeyPair } from "jose";

import { COLLABORATION_SERVER_ARTIFACT } from "./build-server";

const DEFAULT_TIMEOUTS = Object.freeze({
  requestMs: 5_000,
  shutdownMs: 15_000,
  startupMs: 20_000,
});
const MAX_STARTUP_OUTPUT_BYTES = 16 * 1024;
const SAFE_INHERITED_ENVIRONMENT_NAMES = [
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
] as const;

type SmokeTimeouts = {
  requestMs: number;
  shutdownMs: number;
  startupMs: number;
};

type ChildExit = {
  code: number | null;
  error: boolean;
  signal: NodeJS.Signals | null;
};

export type CollaborationSmokeOptions = {
  artifactPath?: string;
  nodeExecutable?: string;
  root?: string;
  timeouts?: Partial<SmokeTimeouts>;
};

export type CollaborationSmokeResult = {
  exitCode: number;
  exitSignal: null;
  liveStatus: 200;
  readyStatus: 200;
};

export async function smokeCollaborationServer(
  options: CollaborationSmokeOptions = {},
): Promise<CollaborationSmokeResult> {
  const root = options.root ?? process.cwd();
  const artifactPath = options.artifactPath
    ?? resolve(root, COLLABORATION_SERVER_ARTIFACT);
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeouts = normalizeTimeouts(options.timeouts);
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "coredot-collaboration-smoke-"),
  );
  let child: ChildProcess | undefined;

  try {
    const databaseUrl = `file:${resolve(temporaryDirectory, "collaboration.db")}`;
    await migrateTemporaryDatabase(databaseUrl, root);
    const verifier = await createPublicVerifier();
    child = spawn(nodeExecutable, [artifactPath], {
      cwd: root,
      env: createSmokeEnvironment(process.env, databaseUrl, verifier),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.resume();

    const httpUrl = await waitForListening(child, timeouts.startupMs);
    const liveStatus = await verifyHealthEndpoint(
      `${httpUrl}/live`,
      "live",
      timeouts.requestMs,
    );
    const readyStatus = await verifyHealthEndpoint(
      `${httpUrl}/ready`,
      "ready",
      timeouts.requestMs,
    );

    const exit = await signalAndWait(child, timeouts.shutdownMs);
    if (exit.error || exit.code !== 0 || exit.signal !== null) throw smokeFailure();

    return {
      exitCode: exit.code,
      exitSignal: null,
      liveStatus,
      readyStatus,
    };
  } catch {
    throw smokeFailure();
  } finally {
    if (child) await stopChild(child, timeouts.shutdownMs);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function normalizeTimeouts(overrides: Partial<SmokeTimeouts> | undefined) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  if (
    !Number.isInteger(timeouts.requestMs)
    || !Number.isInteger(timeouts.shutdownMs)
    || !Number.isInteger(timeouts.startupMs)
    || timeouts.requestMs < 1
    || timeouts.shutdownMs < 1
    || timeouts.startupMs < 1
  ) {
    throw smokeFailure();
  }
  return timeouts;
}

async function migrateTemporaryDatabase(databaseUrl: string, root: string) {
  const client = createClient({ url: databaseUrl });
  try {
    await migrate(drizzle(client), { migrationsFolder: resolve(root, "drizzle") });
  } finally {
    client.close();
  }
}

async function createPublicVerifier() {
  const { publicKey } = await generateKeyPair("ES256", { extractable: true });
  return JSON.stringify({
    keys: [{
      alg: "ES256",
      kid: "collaboration-smoke",
      publicJwk: await exportJWK(publicKey),
    }],
  });
}

function createSmokeEnvironment(
  base: NodeJS.ProcessEnv,
  databaseUrl: string,
  verificationKeyRing: string,
) {
  const environment: NodeJS.ProcessEnv = {
    COLLABORATION_ALLOWED_HOSTS: "127.0.0.1",
    COLLABORATION_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
    COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: verificationKeyRing,
    COLLABORATION_SERVER_ADDRESS: "127.0.0.1",
    COLLABORATION_SERVER_PORT: "0",
    COLLABORATION_SHUTDOWN_GRACE_MS: "2000",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
  };
  for (const name of SAFE_INHERITED_ENVIRONMENT_NAMES) {
    const value = base[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function waitForListening(child: ChildProcess, timeoutMs: number) {
  const stdout = child.stdout;
  if (!stdout) throw smokeFailure();

  return withTimeout(new Promise<string>((resolvePromise, reject) => {
    let buffered = "";
    let settled = false;
    const finish = (error: boolean, value?: string) => {
      if (settled) return;
      settled = true;
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      stdout.resume();
      if (error || value === undefined) reject(smokeFailure());
      else resolvePromise(value);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      if (Buffer.byteLength(buffered) > MAX_STARTUP_OUTPUT_BYTES) {
        finish(true);
        return;
      }
      for (const line of buffered.split(/\r?\n/)) {
        const url = parseListeningUrl(line);
        if (url) {
          finish(false, url);
          return;
        }
      }
    };
    const onError = () => finish(true);
    const onExit = () => finish(true);
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  }), timeoutMs);
}

function parseListeningUrl(line: string) {
  try {
    const payload = JSON.parse(line) as { httpUrl?: unknown; status?: unknown };
    if (payload.status !== "listening" || typeof payload.httpUrl !== "string") {
      return undefined;
    }
    const url = new URL(payload.httpUrl);
    if (
      url.protocol !== "http:"
      || url.hostname !== "127.0.0.1"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

async function verifyHealthEndpoint(
  url: string,
  expectedStatus: "live" | "ready",
  timeoutMs: number,
): Promise<200> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.text();
    if (
      response.status !== 200
      || response.headers.get("cache-control") !== "no-store"
      || body !== JSON.stringify({ status: expectedStatus })
    ) {
      throw smokeFailure();
    }
    return 200;
  } finally {
    clearTimeout(timer);
  }
}

async function signalAndWait(child: ChildProcess, timeoutMs: number) {
  const exit = waitForChild(child);
  if (!child.kill("SIGTERM")) throw smokeFailure();
  return withTimeout(exit, timeoutMs);
}

function waitForChild(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      error: false,
      signal: child.signalCode,
    });
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    child.once("error", () => finish({ code: null, error: true, signal: null }));
    child.once("exit", (code, signal) => finish({ code, error: false, signal }));
  });
}

async function stopChild(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
    await withTimeout(waitForChild(child), timeoutMs);
  } catch {
    try {
      child.kill("SIGKILL");
      await withTimeout(waitForChild(child), timeoutMs);
    } catch {
      // Cleanup is best effort after the bounded verification has failed.
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(smokeFailure()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function smokeFailure() {
  return new Error("Collaboration startup smoke failed");
}

async function main() {
  const result = await smokeCollaborationServer();
  console.log(JSON.stringify({ ...result, status: "ok" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("Collaboration startup smoke failed");
    process.exitCode = 1;
  });
}
