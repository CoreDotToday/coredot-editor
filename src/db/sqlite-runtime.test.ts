import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLocalSqliteRuntime, gateSqliteClientUntilReady } from "./sqlite-runtime";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local SQLite runtime", () => {
  it("holds database operations until runtime initialization completes", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async (statement: string) => statement);
    const client = gateSqliteClientUntilReady({ execute, protocol: "file" }, ready);

    const pending = client.execute("SELECT 1");
    expect(client.protocol).toBe("file");
    expect(execute).not.toHaveBeenCalled();

    release();
    await expect(pending).resolves.toBe("SELECT 1");
    expect(execute).toHaveBeenCalledWith("SELECT 1");
  });

  it("configures WAL and a bounded native busy wait only for file databases", async () => {
    const execute = vi.fn<(statement: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });

    await configureLocalSqliteRuntime({ execute }, "file:./data/editor.db");

    expect(execute.mock.calls.map(([statement]) => statement)).toEqual([
      "PRAGMA journal_mode = WAL",
      "PRAGMA busy_timeout = 250",
    ]);
  });

  it("does not send local SQLite pragmas to remote databases", async () => {
    const execute = vi.fn<(statement: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });

    await configureLocalSqliteRuntime({ execute }, "libsql://database.example.com");

    expect(execute).not.toHaveBeenCalled();
  });

  it("retries WAL initialization when another connection temporarily holds the database", async () => {
    const busyError = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY_RECOVERY",
    });
    const execute = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockRejectedValueOnce(busyError)
      .mockResolvedValue({ rows: [] });

    await configureLocalSqliteRuntime({ execute }, "file:./data/editor.db");

    expect(execute.mock.calls.map(([statement]) => statement)).toEqual([
      "PRAGMA journal_mode = WAL",
      "PRAGMA journal_mode = WAL",
      "PRAGMA busy_timeout = 250",
    ]);
  });

  it("persists WAL mode on a real local database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-sqlite-runtime-"));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${join(dir, "runtime.db")}` });

    await configureLocalSqliteRuntime(client, `file:${join(dir, "runtime.db")}`);

    const result = await client.execute("PRAGMA journal_mode");
    expect(String(result.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
    client.close();
  });
});
