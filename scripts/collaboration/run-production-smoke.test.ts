// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createCollaborationProductionSmokeEnvironments } from "./run-production-smoke";

const baseEnvironment: NodeJS.ProcessEnv = {
  AWS_SECRET_ACCESS_KEY: "real-aws-secret",
  CI: "true",
  CLERK_SECRET_KEY: "real-clerk-secret",
  COLLABORATION_CAPABILITY_SIGNING_KEY_RING: "real-signing-ring-secret",
  COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: "real-verification-ring-secret",
  DATABASE_AUTH_TOKEN: "real-database-secret",
  HOME: "/tmp/collaboration-smoke-home",
  NODE_ENV: "test",
  NODE_OPTIONS: "--require=/tmp/secret-hook.cjs",
  OPENAI_API_KEY: "real-openai-secret",
  PATH: "/usr/bin:/bin",
  TEST_IDENTITY_SIGNING_SECRET: "real-test-identity-secret",
};

const options = {
  databaseUrl: "file:/tmp/isolated-collaboration-smoke.db",
  sidecarPort: 43211,
  signingRing: "{\"activeKid\":\"smoke\",\"keys\":[]}",
  verificationRing: "{\"keys\":[]}",
  webPort: 43210,
} as const;

describe("collaboration production smoke helpers", () => {
  it("gives the web process only signing material and the sidecar only verification material", () => {
    const { sidecar, web } = createCollaborationProductionSmokeEnvironments(
      baseEnvironment,
      options,
    );

    expect(web).toMatchObject({
      COLLABORATION_CAPABILITY_SIGNING_KEY_RING: options.signingRing,
      COLLABORATION_MODE: "self-hosted",
      COLLABORATION_WEBSOCKET_URL: "ws://127.0.0.1:43211/",
      DATABASE_URL: options.databaseUrl,
      NODE_ENV: "production",
      PORT: "43210",
    });
    expect(Object.hasOwn(web, "COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING")).toBe(false);

    expect(sidecar).toMatchObject({
      COLLABORATION_ALLOWED_HOSTS: "127.0.0.1",
      COLLABORATION_ALLOWED_ORIGINS: "http://127.0.0.1:43210",
      COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: options.verificationRing,
      COLLABORATION_SERVER_ADDRESS: "127.0.0.1",
      COLLABORATION_SERVER_PORT: "43211",
      DATABASE_URL: options.databaseUrl,
      NODE_ENV: "production",
    });
    expect(Object.hasOwn(sidecar, "COLLABORATION_CAPABILITY_SIGNING_KEY_RING")).toBe(false);
  });

  it("never inherits real secrets or process hooks into either child environment", () => {
    const { sidecar, web } = createCollaborationProductionSmokeEnvironments(
      baseEnvironment,
      options,
    );

    for (const environment of [sidecar, web]) {
      expect(environment.PATH).toBe("/usr/bin:/bin");
      expect(environment.HOME).toBe("/tmp/collaboration-smoke-home");
      for (const forbiddenName of [
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_AUTH_TOKEN",
        "NODE_OPTIONS",
        "OPENAI_API_KEY",
        "TEST_IDENTITY_SIGNING_SECRET",
      ]) {
        expect(Object.hasOwn(environment, forbiddenName), forbiddenName).toBe(false);
      }
      expect(JSON.stringify(environment)).not.toMatch(
        /real-(?:aws|clerk|database|openai|signing-ring|verification-ring|test-identity)-secret/,
      );
    }
  });

  it("keeps the collaboration release gates wired in package.json and CI", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts["collaboration:production-smoke"]).toBe(
      "tsx --conditions=react-server scripts/collaboration/run-production-smoke.ts",
    );
    expect(packageJson.scripts["collaboration:websocket-tests"]).toBe(
      "tsx --conditions=react-server scripts/collaboration/run-websocket-tests.ts",
    );
    expect(packageJson.scripts["docker:collaboration:verify"]).toBe(
      "tsx scripts/collaboration/verify-docker.ts",
    );
    expect(packageJson.scripts["e2e:collaboration"]).toBe(
      'pnpm e2e --grep "real-time collaboration"',
    );
    for (const focused of [
      "pnpm test:collaboration",
      "pnpm collaboration:websocket-tests",
      "pnpm docker:collaboration:verify",
    ]) {
      expect(packageJson.scripts["release:check"]).toContain(focused);
    }
    expect(workflow).toContain("run: pnpm collaboration:websocket-tests");
    expect(workflow).toContain("run: pnpm docker:collaboration:verify");
    expect(workflow).toContain("run: pnpm collaboration:production-smoke");
  });
});
