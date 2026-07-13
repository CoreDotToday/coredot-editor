import { describe, expect, it } from "vitest";
import * as route from "./route";

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

describe("/api/health", () => {
  it("returns a minimal uncached liveness response", async () => {
    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns an empty uncached HEAD response", async () => {
    const response = await route.HEAD();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("advertises only the public liveness methods", async () => {
    const response = await route.OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe(ALLOWED_METHODS);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
