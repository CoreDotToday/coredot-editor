import { defineConfig, devices } from "@playwright/test";

const e2eEnv = {
  AI_PROVIDER: "stub",
  DATABASE_URL: "file:./data/e2e/coredot-e2e.db",
};
const e2ePort = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  webServer: {
    command: `AI_PROVIDER=${e2eEnv.AI_PROVIDER} DATABASE_URL=${e2eEnv.DATABASE_URL} pnpm exec next dev -p ${e2ePort}`,
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
