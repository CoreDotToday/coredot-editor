import { defineConfig, devices } from "@playwright/test";

const e2eEnv = {
  AI_PROVIDER: "stub",
  DATABASE_URL: "file:./data/e2e/coredot-e2e.db",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  webServer: {
    command: `AI_PROVIDER=${e2eEnv.AI_PROVIDER} DATABASE_URL=${e2eEnv.DATABASE_URL} pnpm dev`,
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
