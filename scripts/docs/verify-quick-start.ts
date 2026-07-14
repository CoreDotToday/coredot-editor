import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQuickStartResponse,
  createQuickStartEnvironment,
  listTrackedWorkingFiles,
  runCleanupSteps,
  runQuickStartVerification,
} from "./verify-quick-start-internal";

export {
  assertQuickStartResponse,
  createQuickStartEnvironment,
  listTrackedWorkingFiles,
  runCleanupSteps,
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);

async function main() {
  try {
    await runQuickStartVerification();
    console.log(JSON.stringify({ status: "ok" }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  void main();
}
