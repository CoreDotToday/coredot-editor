import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./url";

describe("resolveDatabaseUrl", () => {
  it("resolves the default database file relative to the app root", () => {
    expect(resolveDatabaseUrl(undefined, "/tmp/elsewhere")).toBe("file:/tmp/elsewhere/data/coredot.db");
  });

  it("normalizes relative file URLs relative to the app root", () => {
    expect(resolveDatabaseUrl("file:./custom/app.db", "/tmp/app-root")).toBe("file:/tmp/app-root/custom/app.db");
  });

  it("preserves absolute file URLs and remote database URLs", () => {
    expect(resolveDatabaseUrl("file:/tmp/existing.db", "/tmp/app-root")).toBe("file:/tmp/existing.db");
    expect(resolveDatabaseUrl("libsql://example.turso.io", "/tmp/app-root")).toBe("libsql://example.turso.io");
  });
});
