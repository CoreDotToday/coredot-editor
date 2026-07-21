import { generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Test-only secret for the signed multi-identity seam (AUTH_MODE=test). The
 * seam is inert in production builds; this constant exists so specs can sign
 * per-request identity headers that the dev server can verify.
 */
export const E2E_TEST_IDENTITY_SIGNING_SECRET =
  "coredot-e2e-test-identity-signing-secret";

const requestedPort = Number.parseInt(process.env.E2E_PORT ?? "", 10);
const e2ePort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 3100;
const requestedCollaborationPort = Number.parseInt(
  process.env.E2E_COLLABORATION_PORT ?? "",
  10,
);
const e2eCollaborationPort =
  Number.isFinite(requestedCollaborationPort) && requestedCollaborationPort > 0
    ? requestedCollaborationPort
    : 3101;
const requestedWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? "", 10);
const e2eWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : process.env.CI
      ? 2
      : 1;

// A fresh throwaway ES256 pair per run: the web server signs collaboration
// capabilities with the private JWK while the sidecar only ever receives the
// public verification JWK, mirroring the production key separation.
function createE2eCollaborationKeyRings() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = "e2e-collaboration";
  return {
    signingRing: JSON.stringify({
      activeKid: kid,
      keys: [{ alg: "ES256", kid, privateJwk: privateKey.export({ format: "jwk" }) }],
    }),
    verificationRing: JSON.stringify({
      keys: [{ alg: "ES256", kid, publicJwk: publicKey.export({ format: "jwk" }) }],
    }),
  };
}

const collaborationKeyRings = createE2eCollaborationKeyRings();

const e2eEnv = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
  COLLABORATION_CAPABILITY_SIGNING_KEY_RING: collaborationKeyRings.signingRing,
  COLLABORATION_MODE: "self-hosted",
  COLLABORATION_WEBSOCKET_URL: `ws://127.0.0.1:${e2eCollaborationPort}/`,
  DATABASE_URL: "file:./data/e2e/coredot-e2e.db",
  TEST_IDENTITY_SIGNING_SECRET: E2E_TEST_IDENTITY_SIGNING_SECRET,
  TEST_PRINCIPAL_ID: "e2e-user",
  TEST_WORKSPACE_ID: "e2e-workspace",
};

const collaborationServerEnv = {
  COLLABORATION_ALLOWED_HOSTS: "127.0.0.1",
  COLLABORATION_ALLOWED_ORIGINS: `http://127.0.0.1:${e2ePort}`,
  COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: collaborationKeyRings.verificationRing,
  COLLABORATION_SERVER_ADDRESS: "127.0.0.1",
  COLLABORATION_SERVER_PORT: String(e2eCollaborationPort),
  COLLABORATION_SHUTDOWN_GRACE_MS: "10000",
  DATABASE_URL: "file:./data/e2e/coredot-e2e.db",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: e2eWorkers,
  webServer: [
    {
      command: `pnpm exec next dev -p ${e2ePort}`,
      env: e2eEnv,
      url: `http://127.0.0.1:${e2ePort}`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command:
        "pnpm exec tsx --conditions=react-server src/features/collaboration/server/main.ts",
      env: collaborationServerEnv,
      url: `http://127.0.0.1:${e2eCollaborationPort}/ready`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
