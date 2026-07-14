import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  interruptExitCode,
  runInterruptibleTask,
  spawnManagedProcess,
  stopManagedProcess,
  waitForPortRelease,
  type ManagedProcess,
} from "../managed-process";

async function main() {
  const fixtureRoot = dirname(fileURLToPath(import.meta.url));
  const [resultPath, rawPort] = process.argv.slice(2);
  const port = Number(rawPort);
  if (!resultPath || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid interrupt harness input");
  }

  let temporaryRoot: string | undefined;
  let managed: ManagedProcess | undefined;
  let identities: { leafPid: number; parentPid: number } | undefined;
  let cleanupCount = 0;

  const outcome = await runInterruptibleTask({
    cleanup: async (signal) => {
      cleanupCount += 1;
      let failed = false;
      for (const step of [
        async () => {
          if (managed) {
            await stopManagedProcess(managed, {
              forceTimeoutMs: 2_000,
              gracefulTimeoutMs: 200,
            });
          }
        },
        async () => {
          await waitForPortRelease(port, { signal, timeoutMs: 2_000 });
        },
        async () => {
          if (temporaryRoot) {
            await rm(temporaryRoot, { force: true, recursive: true });
          }
        },
      ]) {
        try {
          await step();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Interrupt harness cleanup failed");
    },
    cleanupTimeoutMs: 8_000,
    execute: async (signal) => {
      temporaryRoot = await mkdtemp(
        join(tmpdir(), "coredot-interrupt-harness-"),
      );
      const marker = join(temporaryRoot, "tree.json");
      const fixture = resolve(fixtureRoot, "managed-process-tree.mjs");
      managed = spawnManagedProcess(
        process.execPath,
        [fixture, "parent", String(port), marker],
        { cwd: fixtureRoot, env: process.env },
      );
      identities = await waitForJson<{
        leafPid: number;
        parentPid: number;
      }>(marker, signal);
      await writeFile(
        resultPath,
        JSON.stringify({
          ...identities,
          port,
          status: "ready",
          temporaryRoot,
        }),
        "utf8",
      );
      await waitForAbort(signal);
      throw new Error("Interrupt harness was aborted");
    },
  });

  if (!("signal" in outcome) || !identities || !temporaryRoot) {
    throw new Error("Interrupt harness did not receive a signal");
  }
  await writeFile(
    resultPath,
    JSON.stringify({
      ...identities,
      cleanupCount,
      port,
      signal: outcome.signal,
      status: "cleaned",
      temporaryRoot,
    }),
    "utf8",
  );
  process.exitCode = interruptExitCode(outcome.signal);
}

async function waitForJson<T>(path: string, signal: AbortSignal): Promise<T> {
  while (!signal.aborted) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("Interrupt harness was aborted");
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveAbort) =>
    signal.addEventListener("abort", () => resolveAbort(), { once: true }),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Interrupt harness failed",
  );
  process.exitCode = 1;
});
