import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const MAX_TEST_WORKERS = 8;

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/.git/**", "e2e/**"],
    globals: true,
    // Keep jsdom and CPU-heavy DOCX suites below the host-wide worker count so
    // per-test deadlines measure behavior instead of scheduler contention.
    maxWorkers: MAX_TEST_WORKERS,
    passWithNoTests: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(rootDir, "./src"),
      "server-only": resolve(rootDir, "./src/test/server-only.ts"),
    },
  },
});
