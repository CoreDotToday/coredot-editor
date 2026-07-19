import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const MINIMUM_NODE_MAJOR = 22 as const;
const EXPECTED_NODE_ENGINE = ">=22.13.0";
const EXPECTED_COLLABORATION_BUILD = "tsx scripts/collaboration/build-server.ts";
const EXPECTED_COLLABORATION_DEV = "tsx watch src/features/collaboration/server/main.ts";
const EXPECTED_COLLABORATION_SMOKE = "tsx scripts/collaboration/smoke-server.ts";
const EXPECTED_COLLABORATION_VERIFY_RUNTIME =
  "tsx scripts/collaboration/verify-runtime.ts";
const EXPECTED_RELEASE_COMMANDS = [
  "pnpm collaboration:verify-runtime",
  "pnpm collaboration:build",
  "pnpm collaboration:smoke",
] as const;
const MAX_ERRORS = 8;
const WORKFLOW_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/docs.yml",
] as const;

type PackageManifest = {
  engines?: { node?: unknown };
  scripts?: {
    "build:docx-worker"?: unknown;
    "collaboration:build"?: unknown;
    "collaboration:dev"?: unknown;
    "collaboration:smoke"?: unknown;
    "collaboration:verify-runtime"?: unknown;
    "release:check"?: unknown;
  };
};

type JsonRecord = Record<string, unknown>;

export type RuntimeVerification =
  | { minimumMajor: typeof MINIMUM_NODE_MAJOR; ok: true }
  | {
      errors: string[];
      ok: false;
    };

export async function verifyRuntimeConfiguration(
  root: string,
): Promise<RuntimeVerification> {
  const errors: string[] = [];
  const addError = (error: string) => {
    if (errors.length < MAX_ERRORS && !errors.includes(error)) errors.push(error);
  };

  let manifest: PackageManifest | undefined;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as PackageManifest;
  } catch {
    addError("package.json: unable to read runtime configuration");
  }

  if (manifest) {
    if (manifest.engines?.node !== EXPECTED_NODE_ENGINE) {
      addError("package.json: engines.node must require Node 22.13.0 or newer");
    }
    const workerBuild = manifest.scripts?.["build:docx-worker"];
    if (typeof workerBuild !== "string" || !workerBuild.includes("--target=node22")) {
      addError("package.json: build:docx-worker must target Node 22");
    }
    if (
      manifest.scripts?.["collaboration:build"] !== EXPECTED_COLLABORATION_BUILD
      || manifest.scripts?.["collaboration:dev"] !== EXPECTED_COLLABORATION_DEV
      || manifest.scripts?.["collaboration:smoke"] !== EXPECTED_COLLABORATION_SMOKE
      || manifest.scripts?.["collaboration:verify-runtime"]
        !== EXPECTED_COLLABORATION_VERIFY_RUNTIME
    ) {
      addError("package.json: collaboration scripts must match the approved server contract");
    }
    if (
      typeof manifest.scripts?.["release:check"] !== "string"
      || !hasReleaseSequence(manifest.scripts["release:check"])
    ) {
      addError("package.json: release:check must build and smoke the collaboration sidecar");
    }
  }

  await Promise.all(
    WORKFLOW_PATHS.map(async (workflowPath) => {
      try {
        const workflow = await readFile(resolve(root, workflowPath), "utf8");
        if (!everySetupNodeStepUsesNode22(parse(workflow))) {
          addError(`${workflowPath}: every setup-node job must use Node 22`);
        }
      } catch {
        addError(`${workflowPath}: unable to read runtime configuration`);
      }
    }),
  );

  return errors.length === 0
    ? { minimumMajor: MINIMUM_NODE_MAJOR, ok: true }
    : { errors, ok: false };
}

function hasReleaseSequence(script: string) {
  const commands = script.split("&&").map((command) => command.trim());
  return commands.some((_command, index) =>
    EXPECTED_RELEASE_COMMANDS.every(
      (expected, offset) => commands[index + offset] === expected,
    ));
}

function everySetupNodeStepUsesNode22(value: unknown) {
  if (!isRecord(value) || !isRecord(value.jobs)) return false;
  let foundSetupNode = false;

  for (const job of Object.values(value.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (
        !isRecord(step)
        || typeof step.uses !== "string"
        || !step.uses.startsWith("actions/setup-node@")
      ) {
        continue;
      }
      foundSetupNode = true;
      if (
        !isRecord(step.with)
        || String(step.with["node-version"]) !== String(MINIMUM_NODE_MAJOR)
      ) {
        return false;
      }
    }
  }

  return foundSetupNode;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const result = await verifyRuntimeConfiguration(process.cwd());
  if (result.ok) {
    console.log(JSON.stringify({ minimumMajor: result.minimumMajor, status: "ok" }));
    return;
  }

  for (const error of result.errors) console.error(error);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("scripts/collaboration/verify-runtime.ts: verification failed");
    process.exitCode = 1;
  });
}
