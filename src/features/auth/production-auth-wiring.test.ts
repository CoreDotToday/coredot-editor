import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("production auth wiring", () => {
  it("provides one dependency-free validator with TypeScript declarations", () => {
    expect(
      existsSync(
        resolve(root, "src/features/auth/production-auth-config.mjs"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(root, "src/features/auth/production-auth-config.d.mts"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(root, "src/features/auth/production-auth-config.ts"),
      ),
    ).toBe(false);
  });

  it("uses the shared validator from the production preflight", () => {
    expect(read("scripts/validate-production-auth.mjs")).toContain(
      'from "../src/features/auth/production-auth-config.mjs"',
    );
  });

  it("verifies valid production startup reaches readiness", () => {
    expect(read("scripts/security/verify-production-auth-startup.mjs")).toContain(
      "verifyValidProductionStartupReachesReadiness",
    );
  });

  it("includes startup verification in the release gate", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["release:check"]).toContain(
      "pnpm security:verify-auth-startup",
    );
  });
});
