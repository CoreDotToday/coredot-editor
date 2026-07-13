import { describe, expect, it } from "vitest";
import { resolveDatabaseCredentials, resolveDatabaseUrl } from "./url";

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

describe("resolveDatabaseCredentials", () => {
  it("preserves the default and relative local file URL behavior", () => {
    expect(resolveDatabaseCredentials({}, "/tmp/app-root")).toEqual({
      url: "file:/tmp/app-root/data/coredot.db",
    });
    expect(
      resolveDatabaseCredentials(
        { DATABASE_URL: "file:./custom/app.db" },
        "/tmp/app-root",
      ),
    ).toEqual({ url: "file:/tmp/app-root/custom/app.db" });
  });

  it("does not read the ambient database URL when an explicit environment is provided", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "libsql://ambient.example";

    try {
      expect(resolveDatabaseCredentials({}, "/tmp/app-root")).toEqual({
        url: "file:/tmp/app-root/data/coredot.db",
      });
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it("preserves absolute local file and remote database URLs", () => {
    expect(
      resolveDatabaseCredentials(
        { DATABASE_URL: "file:/tmp/existing.db" },
        "/tmp/app-root",
      ),
    ).toEqual({ url: "file:/tmp/existing.db" });
    expect(
      resolveDatabaseCredentials(
        { DATABASE_URL: "libsql://example.turso.io" },
        "/tmp/app-root",
      ),
    ).toEqual({ url: "libsql://example.turso.io" });
  });

  it("uses the canonical database auth token", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        DATABASE_AUTH_TOKEN: "canonical-token",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "canonical-token",
    });
  });

  it("falls back to the compatibility Turso auth token", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN: "compatibility-token",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "compatibility-token",
    });
  });

  it("prefers the canonical token when both tokens are configured", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        DATABASE_AUTH_TOKEN: "canonical-token",
        TURSO_AUTH_TOKEN: "compatibility-token",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "canonical-token",
    });
  });

  it("treats whitespace-only tokens as absent and omits the authToken property", () => {
    const credentials = resolveDatabaseCredentials(
      {
        DATABASE_AUTH_TOKEN: "   ",
        TURSO_AUTH_TOKEN: "\t\n",
      },
      "/tmp/app-root",
    );

    expect(credentials).toEqual({
      url: "file:/tmp/app-root/data/coredot.db",
    });
    expect(Object.hasOwn(credentials, "authToken")).toBe(false);
  });

  it("falls back when the canonical token is whitespace-only", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        DATABASE_AUTH_TOKEN: "  ",
        TURSO_AUTH_TOKEN: "compatibility-token",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "compatibility-token",
    });
  });

  it("trims the selected canonical token", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        DATABASE_AUTH_TOKEN: "  canonical-token\n",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "canonical-token",
    });
  });

  it("trims the selected compatibility token", () => {
    expect(
      resolveDatabaseCredentials({
        DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN: "\tcompatibility-token  ",
      }),
    ).toEqual({
      url: "libsql://example.turso.io",
      authToken: "compatibility-token",
    });
  });
});
