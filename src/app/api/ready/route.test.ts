import { beforeEach, describe, expect, it, vi } from "vitest";
import { READINESS_DATABASE_QUERY } from "@/features/health/readiness";

const execute = vi.hoisted(() => vi.fn());

vi.mock("@/db/client", () => ({
  sqliteClient: { execute },
}));

import * as route from "./route";

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";
const TOOL_RUN_NONCE_HEADER = "X-Coredot-Tool-Run-Nonce";

function request(
  method: "GET" | "HEAD" = "GET",
  nonce?: string,
) {
  return new Request("http://localhost/api/ready", {
    headers: nonce ? { [TOOL_RUN_NONCE_HEADER]: nonce } : undefined,
    method,
  });
}

describe("/api/ready", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rows: [] });
    delete process.env.COREDOT_TOOL_RUN_NONCE;
    delete process.env.AUTH_MODE;
  });

  it("echoes a matching capture nonce only in test auth mode", async () => {
    const nonce = "capture_nonce_123456789012345678901234567890";
    process.env.AUTH_MODE = "test";
    process.env.COREDOT_TOOL_RUN_NONCE = nonce;

    const matching = await route.GET(request("GET", nonce));
    const absent = await route.GET(request());
    const wrong = await route.GET(request("GET", `${nonce}_wrong`));
    process.env.AUTH_MODE = "clerk";
    const production = await route.GET(request("GET", nonce));

    expect(matching.headers.get(TOOL_RUN_NONCE_HEADER)).toBe(nonce);
    expect(absent.headers.get(TOOL_RUN_NONCE_HEADER)).toBeNull();
    expect(wrong.headers.get(TOOL_RUN_NONCE_HEADER)).toBeNull();
    expect(production.headers.get(TOOL_RUN_NONCE_HEADER)).toBeNull();
    await expect(matching.json()).resolves.toEqual({ status: "ready" });
  });

  it("uses the gated production database client for the schema-compatible readiness check", async () => {
    const response = await route.GET(request());

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(READINESS_DATABASE_QUERY);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("returns an empty HEAD response with the database readiness status", async () => {
    execute.mockRejectedValue(new Error("private database detail"));

    const response = await route.HEAD(request("HEAD"));

    expect(execute).toHaveBeenCalledWith(READINESS_DATABASE_QUERY);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("advertises only the public readiness methods without querying the database", async () => {
    const response = await route.OPTIONS();

    expect(execute).not.toHaveBeenCalled();
    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe(ALLOWED_METHODS);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
