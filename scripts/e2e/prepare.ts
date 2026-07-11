import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "../../src/db/url";

export const E2E_DATABASE_URL = "file:./data/e2e/coredot-e2e.db";
export const E2E_DATABASE_PATH = resolve(APP_ROOT, "data/e2e/coredot-e2e.db");
export const E2E_ENV = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
  DATABASE_URL: E2E_DATABASE_URL,
  TEST_PRINCIPAL_ID: "e2e-user",
  TEST_WORKSPACE_ID: "e2e-workspace",
} as const;

const sqliteSidecarSuffixes = ["", "-shm", "-wal", "-journal"];

export async function removeE2eDatabaseFiles(databasePath = E2E_DATABASE_PATH) {
  await Promise.all(
    sqliteSidecarSuffixes.map((suffix) =>
      rm(`${databasePath}${suffix}`, {
        force: true,
        recursive: false,
      }),
    ),
  );
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function prepareE2eDatabase() {
  const env = { ...process.env, ...E2E_ENV };

  await mkdir(dirname(E2E_DATABASE_PATH), { recursive: true });
  await removeE2eDatabaseFiles();
  await runCommand("pnpm", ["db:migrate"], env);

  Object.assign(process.env, E2E_ENV);
  const { ensureWorkspaceBootstrap } = await import("../../src/features/workspaces/workspace-bootstrap");
  await ensureWorkspaceBootstrap({ workspaceId: E2E_ENV.TEST_WORKSPACE_ID });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareE2eDatabase().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
