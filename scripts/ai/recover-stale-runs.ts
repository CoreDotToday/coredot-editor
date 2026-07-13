import { pathToFileURL } from "node:url";

const DEFAULT_STALE_AFTER_MINUTES = 15;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_STALE_AFTER_MINUTES = 1;
const MAX_STALE_AFTER_MINUTES = 7 * 24 * 60;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

type RecoveryArguments = {
  staleAfterMinutes: number;
  timeoutMs: number;
};

type RecoveryInput = {
  before: Date;
  now: Date;
};

type RecoveryResult = {
  recoveredCount: number;
};

type RunRecoveryCliOptions = {
  argv: string[];
  now?: Date;
  recover: (input: RecoveryInput) => Promise<RecoveryResult>;
  writeStderr?: (value: string) => void;
  writeStdout?: (value: string) => void;
};

export function parseRecoveryArguments(argv: string[]): RecoveryArguments {
  let staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let sawStaleAfter = false;
  let sawTimeout = false;
  const arguments_ = argv[0] === "--" ? argv.slice(1) : argv;

  for (const argument of arguments_) {
    if (argument.startsWith("--stale-after-minutes=")) {
      if (sawStaleAfter) throw new Error("Invalid recovery arguments");
      sawStaleAfter = true;
      staleAfterMinutes = parseBoundedInteger(
        argument.slice("--stale-after-minutes=".length),
        MIN_STALE_AFTER_MINUTES,
        MAX_STALE_AFTER_MINUTES,
      );
      continue;
    }
    if (argument.startsWith("--timeout-ms=")) {
      if (sawTimeout) throw new Error("Invalid recovery arguments");
      sawTimeout = true;
      timeoutMs = parseBoundedInteger(
        argument.slice("--timeout-ms=".length),
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      continue;
    }
    throw new Error("Invalid recovery arguments");
  }

  return { staleAfterMinutes, timeoutMs };
}

export async function runRecoveryCli(options: RunRecoveryCliOptions): Promise<0 | 1> {
  const writeStderr = options.writeStderr ?? ((value: string) => console.error(value));
  const writeStdout = options.writeStdout ?? ((value: string) => console.log(value));

  try {
    const { staleAfterMinutes, timeoutMs } = parseRecoveryArguments(options.argv);
    const now = options.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid recovery arguments");
    const before = new Date(now.getTime() - staleAfterMinutes * 60_000);
    const result = await withTimeout(
      Promise.resolve().then(() => options.recover({ before, now })),
      timeoutMs,
    );
    writeStdout(JSON.stringify({ recoveredCount: result.recoveredCount, status: "ok" }));
    return 0;
  } catch {
    writeStderr(JSON.stringify({ status: "failed" }));
    return 1;
  }
}

function parseBoundedInteger(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value)) throw new Error("Invalid recovery arguments");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Invalid recovery arguments");
  }
  return parsed;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Recovery timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function main() {
  let closeDatabase: (() => void) | undefined;
  const exitCode = await runRecoveryCli({
    argv: process.argv.slice(2),
    recover: async (input) => {
      const [{ db, sqliteClient }, { recoverStaleAiRuns }] = await Promise.all([
        import("../../src/db/client"),
        import("../../src/features/ai/recover-stale-runs"),
      ]);
      closeDatabase = () => sqliteClient.close();
      return recoverStaleAiRuns(db, input);
    },
  });
  try {
    closeDatabase?.();
  } catch {
    // Closing is best effort; never expose database details from the maintenance CLI.
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  });
}
