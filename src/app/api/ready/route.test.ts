import { beforeEach, describe, expect, it, vi } from "vitest";
import { READINESS_DATABASE_QUERY } from "@/features/health/readiness";

const execute = vi.hoisted(() => vi.fn());

vi.mock("@/db/client", () => ({
  sqliteClient: { execute },
}));

import * as route from "./route";

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

function request(method: "GET" | "HEAD" = "GET") {
  return new Request("http://localhost/api/ready", { method });
}

describe("/api/ready", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rows: [] });
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
