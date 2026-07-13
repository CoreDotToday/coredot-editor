import { describe, expect, it, vi } from "vitest";
import { isRetryableSqliteContention, retrySqliteContention } from "./sqlite-contention";

describe("SQLite contention retry", () => {
  it("recognizes SQLite busy and locked errors through wrapped causes", () => {
    expect(isRetryableSqliteContention(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))).toBe(true);
    expect(isRetryableSqliteContention(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }))).toBe(true);
    expect(
      isRetryableSqliteContention(
        new Error("query failed", {
          cause: Object.assign(new Error("snapshot busy"), {
            code: "SQLITE_BUSY_SNAPSHOT",
          }),
        }),
      ),
    ).toBe(true);
    expect(isRetryableSqliteContention(new Error("database is locked"))).toBe(true);
    expect(isRetryableSqliteContention(Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT" }))).toBe(
      false,
    );
    expect(isRetryableSqliteContention(new Error("network unavailable"))).toBe(false);
  });

  it("retries only known contention with bounded exponential backoff", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }))
      .mockResolvedValueOnce("saved");
    const sleep = vi.fn(async () => undefined);

    await expect(
      retrySqliteContention(operation, {
        attempts: 4,
        initialDelayMs: 2,
        sleep,
      }),
    ).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2], [4]]);
  });

  it("propagates non-contention errors without retrying", async () => {
    const error = Object.assign(new Error("constraint"), {
      code: "SQLITE_CONSTRAINT",
    });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retrySqliteContention(operation, { attempts: 4, initialDelayMs: 0 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured contention attempt bound", async () => {
    const error = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retrySqliteContention(operation, { attempts: 3, initialDelayMs: 0 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
