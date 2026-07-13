import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READINESS_DATABASE_QUERY,
  createReadinessHandler,
} from "./readiness";

function createRequest(signal?: AbortSignal) {
  return new Request("http://localhost/api/ready", { signal });
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("database readiness handler", () => {
  it("checks the latest schema marker and returns an exact generic success response", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const handler = createReadinessHandler({ execute }, { timeoutMs: 50 });

    const response = await handler(createRequest());

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(READINESS_DATABASE_QUERY);
    expect(READINESS_DATABASE_QUERY).toBe("SELECT execution_token FROM ai_runs LIMIT 0");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it.each([
    "database unavailable at libsql://user:secret-token@private.example",
    "SQLITE_ERROR: no such column: execution_token",
  ])("returns the same generic failure without leaking database details: %s", async (message) => {
    const handler = createReadinessHandler(
      { execute: vi.fn(async () => { throw new Error(message); }) },
      { timeoutMs: 50 },
    );

    const response = await handler(createRequest());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toBe(JSON.stringify({ status: "unavailable" }));
    expect(body).not.toContain(message);
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("execution_token");
  });

  it("bounds a stalled check, clears resources, and handles a late rejection", async () => {
    vi.useFakeTimers();
    const databaseResult = deferred<unknown>();
    const execute = vi.fn(() => databaseResult.promise);
    const handler = createReadinessHandler({ execute }, { timeoutMs: 25 });

    const responsePromise = handler(createRequest());
    await vi.advanceTimersByTimeAsync(25);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);

    databaseResult.reject(new Error("late libsql://secret-token@private.example failure"));
    await Promise.resolve();
  });

  it("does not access the database for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ rows: [] }));
    const handler = createReadinessHandler({ execute }, { timeoutMs: 50 });

    const response = await handler(createRequest(controller.signal));

    expect(response.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns promptly on mid-flight abort and cleans listeners and timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = createRequest(controller.signal);
    const removeEventListener = vi.spyOn(request.signal, "removeEventListener");
    const databaseResult = deferred<unknown>();
    const handler = createReadinessHandler(
      { execute: vi.fn(() => databaseResult.promise) },
      { timeoutMs: 500 },
    );

    const responsePromise = handler(request);
    await Promise.resolve();
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    databaseResult.reject(new Error("late failure after abort"));
    await Promise.resolve();
  });

  it("can return an empty HEAD response while preserving readiness status", async () => {
    const handler = createReadinessHandler(
      { execute: vi.fn(async () => ({ rows: [] })) },
      { includeBody: false, timeoutMs: 50 },
    );

    const response = await handler(createRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
