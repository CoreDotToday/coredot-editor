import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { APP_ROOT } from "../../src/db/url";
import {
  assertExactJsonResponse,
  fetchSmokeResponse,
  withPhaseTimeout,
} from "../e2e/run-production-smoke";
import { createCollaborationCapabilityKeyRings } from "./run-websocket-tests";

const COMPOSE_FILE = "docker-compose.collaboration.yml";
const SERVICE = "collaboration";
const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024;
const TIMEOUTS = Object.freeze({
  buildAndStartMs: 480_000,
  commandMs: 30_000,
  requestMs: 5_000,
  stopMs: 60_000,
});

type CapturedCommand = {
  code: number | null;
  stdout: string;
};

async function runDockerCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CapturedCommand> {
  const child = spawn("docker", args, {
    cwd: APP_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  let truncated = false;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (truncated) return;
    stdout += String(chunk);
    if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURED_OUTPUT_BYTES) {
      truncated = true;
      stdout = stdout.slice(0, MAX_CAPTURED_OUTPUT_BYTES);
    }
  });
  const code = await withPhaseTimeout(
    new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", () => reject(verificationFailure()));
      child.once("exit", (exitCode) => resolvePromise(exitCode));
    }),
    timeoutMs,
  ).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw error;
  });
  return { code, stdout };
}

async function requireSuccessfulDockerCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const result = await runDockerCommand(args, environment, timeoutMs);
  if (result.code !== 0) throw verificationFailure();
  return result;
}

function parsePublishedPort(portOutput: string) {
  const match = /:(\d+)\s*$/.exec(portOutput.trim());
  const port = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw verificationFailure();
  }
  return port;
}

export async function verifyCollaborationDockerEnvironment() {
  const daemon = await runDockerCommand(["info", "--format", "ok"], process.env, TIMEOUTS.commandMs)
    .catch(() => null);
  if (!daemon || daemon.code !== 0) {
    throw new Error("Docker daemon is unavailable for collaboration verification");
  }

  const project = `coredot-collab-verify-${randomBytes(4).toString("hex")}`;
  const { verificationRing } = await createCollaborationCapabilityKeyRings(
    "collaboration-docker-verify",
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: verificationRing,
  };
  const compose = (args: string[]) => [
    "compose",
    "--project-name",
    project,
    "--file",
    COMPOSE_FILE,
    ...args,
  ];

  try {
    reportPhase("build_and_start", "running");
    await requireSuccessfulDockerCommand(
      compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "300"]),
      environment,
      TIMEOUTS.buildAndStartMs,
    );
    reportPhase("build_and_start", "ok");

    reportPhase("readiness", "running");
    const portResult = await requireSuccessfulDockerCommand(
      compose(["port", SERVICE, "1234"]),
      environment,
      TIMEOUTS.commandMs,
    );
    const publishedPort = parsePublishedPort(portResult.stdout);
    const baseUrl = `http://127.0.0.1:${String(publishedPort)}`;
    await assertExactJsonResponse(
      await fetchSmokeResponse(`${baseUrl}/live`, undefined, TIMEOUTS.requestMs),
      200,
      { status: "live" },
    );
    await assertExactJsonResponse(
      await fetchSmokeResponse(`${baseUrl}/ready`, undefined, TIMEOUTS.requestMs),
      200,
      { status: "ready" },
    );
    reportPhase("readiness", "ok");

    reportPhase("graceful_stop", "running");
    const containerResult = await requireSuccessfulDockerCommand(
      compose(["ps", "--quiet", SERVICE]),
      environment,
      TIMEOUTS.commandMs,
    );
    const containerId = containerResult.stdout.trim().split(/\s+/)[0];
    if (!containerId || !/^[0-9a-f]{12,64}$/i.test(containerId)) {
      throw verificationFailure();
    }
    await requireSuccessfulDockerCommand(
      compose(["stop", SERVICE]),
      environment,
      TIMEOUTS.stopMs,
    );
    const exitCodeResult = await requireSuccessfulDockerCommand(
      ["inspect", "--format", "{{.State.ExitCode}}", containerId],
      environment,
      TIMEOUTS.commandMs,
    );
    if (exitCodeResult.stdout.trim() !== "0") throw verificationFailure();
    reportPhase("graceful_stop", "ok");
  } finally {
    await runDockerCommand(
      compose(["down", "--volumes", "--remove-orphans", "--timeout", "30"]),
      environment,
      TIMEOUTS.stopMs,
    ).catch(() => undefined);
  }
}

function reportPhase(phase: string, status: "ok" | "running") {
  console.log(JSON.stringify({ phase, status }));
}

function verificationFailure() {
  return new Error("Collaboration Docker verification failed");
}

async function main() {
  try {
    await verifyCollaborationDockerEnvironment();
    console.log(JSON.stringify({ status: "ok" }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
