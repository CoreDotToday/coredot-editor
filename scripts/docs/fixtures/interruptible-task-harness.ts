import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createManagedCommandOwner,
  interruptExitCode,
  runInterruptibleTask,
  waitForPortRelease,
} from "../managed-process";

async function main() {
  const fixtureRoot = dirname(fileURLToPath(import.meta.url));
  const [resultPath, rawPort, phase] = process.argv.slice(2);
  const port = Number(rawPort);
  if (
    !resultPath ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (phase !== "migration" && phase !== "bootstrap")
  ) {
    throw new Error("Invalid interrupt harness input");
  }

  let temporaryRoot: string | undefined;
  let identities: { leafPid: number; parentPid: number } | undefined;
  let cleanupCount = 0;
  const commandOwner = createManagedCommandOwner();

  const outcome = await runInterruptibleTask({
    cleanup: async (signal) => {
      cleanupCount += 1;
      let failed = false;
      for (const step of [
        async () => {
          await commandOwner.settle({
            forceTimeoutMs: 2_000,
            gracefulTimeoutMs: 200,
          });
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
      const openFilePath = join(temporaryRoot, `${phase}.open`);
      const fixture = resolve(fixtureRoot, "managed-process-tree.mjs");
      const command = commandOwner.run({
        arguments: [
          fixture,
          "parent",
          String(port),
          marker,
          openFilePath,
        ],
        command: process.execPath,
        cwd: fixtureRoot,
        environment: process.env,
        forceTimeoutMs: 2_000,
        gracefulTimeoutMs: 200,
        signal,
        timeoutMs: 30_000,
      });
      identities = await waitForJson<{
        leafPid: number;
        parentPid: number;
      }>(marker, signal);
      await writeFile(
        resultPath,
        JSON.stringify({
          ...identities,
          openFilePath,
          phase,
          port,
          status: "ready",
          temporaryRoot,
        }),
        "utf8",
      );
      await command;
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
      phase,
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

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Interrupt harness failed",
  );
  process.exitCode = 1;
});
