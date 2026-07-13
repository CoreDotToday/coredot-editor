import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseRecoveryArguments, runRecoveryCli } from "./recover-stale-runs";

const execFileAsync = promisify(execFile);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

describe("AI stale-run recovery CLI", () => {
  it("validates bounded stale cutoffs and operation timeouts", () => {
    expect(parseRecoveryArguments([])).toEqual({ staleAfterMinutes: 15, timeoutMs: 10_000 });
    expect(parseRecoveryArguments(["--stale-after-minutes=30", "--timeout-ms=2500"])).toEqual({
      staleAfterMinutes: 30,
      timeoutMs: 2500,
    });
    expect(parseRecoveryArguments(["--", "--stale-after-minutes=30", "--timeout-ms=2500"])).toEqual({
      staleAfterMinutes: 30,
      timeoutMs: 2500,
    });
    for (const argv of [
      ["--stale-after-minutes=0"],
      ["--stale-after-minutes=10081"],
      ["--stale-after-minutes=1.5"],
      ["--timeout-ms=99"],
      ["--timeout-ms=60001"],
      ["--timeout-ms=secret-database-url"],
      ["--unknown=secret"],
      ["--", "--", "--timeout-ms=1000"],
    ]) {
      expect(() => parseRecoveryArguments(argv)).toThrow("Invalid recovery arguments");
    }
  });

  it("prints only a safe aggregate count on success", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const now = new Date("2026-01-03T00:00:00.000Z");
    const recover = vi.fn(async () => ({ recoveredCount: 2 }));

    const exitCode = await runRecoveryCli({
      argv: ["--stale-after-minutes=30", "--timeout-ms=1000"],
      now,
      recover,
      writeStderr: (value) => stderr.push(value),
      writeStdout: (value) => stdout.push(value),
    });

    expect(exitCode).toBe(0);
    expect(recover).toHaveBeenCalledWith({
      before: new Date("2026-01-02T23:30:00.000Z"),
      now,
    });
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([JSON.stringify({ recoveredCount: 2, status: "ok" })]);
    expect(stdout.join(" ")).not.toMatch(/private-run|DATABASE_URL|AUTH_TOKEN|payload/i);
  });

  it("bounds a hung recovery and never prints sensitive errors", async () => {
    vi.useFakeTimers();
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const pending = runRecoveryCli({
        argv: ["--timeout-ms=100"],
        now: new Date("2026-01-03T00:00:00.000Z"),
        recover: async () => new Promise(() => undefined),
        writeStderr: (value) => stderr.push(value),
        writeStdout: (value) => stdout.push(value),
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([JSON.stringify({ status: "failed" })]);
      expect(stderr.join(" ")).not.toMatch(/secret|DATABASE_URL|AUTH_TOKEN|payload|run_/i);
    } finally {
      vi.useRealTimers();
    }

    const rejectedOutput: string[] = [];
    await expect(runRecoveryCli({
      argv: [],
      recover: async () => {
        throw new Error("libsql://user:token@private.example payload run_private");
      },
      writeStderr: (value) => rejectedOutput.push(value),
      writeStdout: () => undefined,
    })).resolves.toBe(1);
    expect(rejectedOutput).toEqual([JSON.stringify({ status: "failed" })]);
  });

  it("accepts the documented pnpm separator at the real process boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coredot-recovery-cli-test-"));
    const environment = {
      ...process.env,
      DATABASE_AUTH_TOKEN: "",
      DATABASE_URL: `file:${join(directory, "recovery-cli.db")}`,
      TURSO_AUTH_TOKEN: "",
    };
    try {
      await execFileAsync(pnpmCommand, ["db:migrate"], {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 20_000,
      });
      const { stdout, stderr } = await execFileAsync(pnpmCommand, [
        "ai:recover-stale-runs",
        "--",
        "--stale-after-minutes=30",
        "--timeout-ms=2500",
      ], {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 20_000,
      });

      expect(stdout).toContain(JSON.stringify({ recoveredCount: 0, status: "ok" }));
      expect(stderr).toBe("");
      expect(`${stdout}${stderr}`).not.toMatch(/AUTH_TOKEN|libsql:\/\/|run_/i);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
