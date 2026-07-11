import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const preflightPath = resolve(
  process.cwd(),
  "scripts/validate-production-auth.mjs",
);

function runPreflight(
  overrides: Record<string, string | undefined> = {},
  args: string[] = [],
) {
  return spawnSync(process.execPath, [preflightPath, ...args], {
    encoding: "utf8",
    env: {
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_unit",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      NODE_ENV: "production",
      PATH: process.env.PATH,
      ...overrides,
    },
  });
}

describe(
  "production auth preflight",
  { sequential: true, timeout: 20_000 },
  () => {
    it("accepts configured Clerk production startup", () => {
      const result = runPreflight();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("rejects missing production Clerk credentials", () => {
      const result = runPreflight({ CLERK_SECRET_KEY: "  " });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Clerk authentication is not configured");
    });

    it("rejects production test authentication", () => {
      const result = runPreflight({ AUTH_MODE: "test" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Test authentication is disabled in production",
      );
    });

    it("preserves development test authentication", () => {
      const result = runPreflight({
        AUTH_MODE: "test",
        CLERK_SECRET_KEY: "",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
        NODE_ENV: "development",
      });

      expect(result.status).toBe(0);
    });

    it("forces production validation for the supported start command", () => {
      const result = runPreflight(
        {
          CLERK_SECRET_KEY: "",
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
          NODE_ENV: "development",
        },
        ["--production"],
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Clerk authentication is not configured");
    });
  },
);
