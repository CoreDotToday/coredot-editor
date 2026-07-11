import { defineConfig, devices } from "@playwright/test";

const e2eEnv = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
  DATABASE_URL: "file:./data/e2e/coredot-e2e.db",
  TEST_PRINCIPAL_ID: "e2e-user",
  TEST_WORKSPACE_ID: "e2e-workspace",
};
const requestedPort = Number.parseInt(process.env.E2E_PORT ?? "", 10);
const e2ePort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 3100;
const requestedWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? "", 10);
const e2eWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : process.env.CI
      ? 2
      : 1;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: e2eWorkers,
  webServer: {
    command: `pnpm exec next dev -p ${e2ePort}`,
    env: e2eEnv,
    url: `http://127.0.0.1:${e2ePort}`,
    reuseExistingServer: false,
  },
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
