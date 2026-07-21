import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_ROOT } from "../../src/db/url";
import { COLLABORATION_TITLE_NAME } from "../../src/features/collaboration/contracts";
import {
  assertExactJsonResponse,
  createProductionSmokeEnvironment,
  fetchSmokeResponse,
  reserveAvailablePort,
  runCleanupSteps,
  runCommand,
  stopProcessTree,
  waitForChild,
  waitForPortRelease,
  withPhaseTimeout,
  type ServerExit,
} from "../e2e/run-production-smoke";
import { COLLABORATION_SERVER_ARTIFACT } from "./build-server";
import {
  connectCollaborationClient,
  createCollaborationCapabilityIssuer,
  createCollaborationCapabilityKeyRings,
  createSidecarEnvironment,
  expectCollaborationConnectionRejected,
  seedInitializedCollaborationDocument,
  waitForSidecarReady,
  type ConnectedCollaborationClient,
} from "./run-websocket-tests";

const TIMEOUTS = Object.freeze({
  buildMs: 300_000,
  convergenceMs: 20_000,
  migrateMs: 60_000,
  readinessMs: 30_000,
  requestMs: 5_000,
  shutdownMs: 15_000,
});

const SMOKE_WORKSPACE_ID = "workspace:production-smoke";
const SMOKE_DOCUMENT_ID = "document:production-smoke";

type CollaborationSmokeEnvironmentOptions = {
  databaseUrl: string;
  sidecarPort: number;
  signingRing: string;
  verificationRing: string;
  webPort: number;
};

/**
 * Builds the two production child environments with strictly separated key
 * material: the web process receives only the private signing ring and the
 * sidecar receives only the public verification ring, mirroring the deployment
 * contract that neither process may hold the other's secrets.
 */
export function createCollaborationProductionSmokeEnvironments(
  baseEnvironment: NodeJS.ProcessEnv,
  options: CollaborationSmokeEnvironmentOptions,
) {
  const web = createProductionSmokeEnvironment(baseEnvironment, {
    databaseUrl: options.databaseUrl,
    port: options.webPort,
  });
  Object.assign(web, {
    COLLABORATION_CAPABILITY_SIGNING_KEY_RING: options.signingRing,
    COLLABORATION_MODE: "self-hosted",
    COLLABORATION_WEBSOCKET_URL: `ws://127.0.0.1:${String(options.sidecarPort)}/`,
  });
  const sidecar = createSidecarEnvironment(baseEnvironment, {
    allowedOrigin: `http://127.0.0.1:${String(options.webPort)}`,
    databaseUrl: options.databaseUrl,
    port: options.sidecarPort,
    verificationRing: options.verificationRing,
  });
  return { sidecar, web };
}

async function assertSidecarHealthContracts(httpUrl: string) {
  await assertExactJsonResponse(
    await fetchSmokeResponse(`${httpUrl}/live`),
    200,
    { status: "live" },
  );
  await assertExactJsonResponse(
    await fetchSmokeResponse(`${httpUrl}/ready`),
    200,
    { status: "ready" },
  );
}

async function waitForWebReadiness(baseUrl: string, serverExit: Promise<ServerExit>) {
  const deadline = Date.now() + TIMEOUTS.readinessMs;
  while (Date.now() < deadline) {
    const ready = await Promise.race([
      fetchSmokeResponse(`${baseUrl}/api/ready`)
        .then((response) => response.status === 200)
        .catch(() => false),
      serverExit.then(() => {
        throw new Error("Collaboration production smoke server exited before readiness");
      }),
    ]);
    if (ready) return;
    await delay(100);
  }
  throw new Error("Collaboration production smoke readiness timed out");
}

async function assertGracefulSidecarDrain(child: ChildProcess) {
  const exit = waitForChild(child);
  if (!child.kill("SIGTERM")) {
    throw new Error("Collaboration production smoke drain failed");
  }
  const outcome = await withPhaseTimeout(exit, TIMEOUTS.shutdownMs);
  if (outcome.error || outcome.code !== 0 || outcome.signal !== null) {
    throw new Error("Collaboration production smoke drain failed");
  }
}

export async function runCollaborationProductionSmoke() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "coredot-collaboration-production-smoke-"),
  );
  const databaseUrl = `file:${join(temporaryDirectory, "collaboration-production-smoke.db")}`;
  let webPort: number | undefined;
  let sidecarPort: number | undefined;
  let webServer: ChildProcess | undefined;
  let sidecarServer: ChildProcess | undefined;
  const clients: ConnectedCollaborationClient[] = [];

  try {
    webPort = await reserveAvailablePort();
    sidecarPort = await reserveAvailablePort();
    const keyRings = await createCollaborationCapabilityKeyRings("collaboration-production-smoke");
    const { sidecar, web } = createCollaborationProductionSmokeEnvironments(process.env, {
      databaseUrl,
      sidecarPort,
      signingRing: keyRings.signingRing,
      verificationRing: keyRings.verificationRing,
      webPort,
    });

    await runCommand(["db:migrate"], web, TIMEOUTS.migrateMs, "migrate");
    await runCommand(["build"], web, TIMEOUTS.buildMs, "build");
    await runCommand(["collaboration:build"], web, TIMEOUTS.buildMs, "collaboration_build");

    reportPhase("seed", "running");
    await seedInitializedCollaborationDocument({
      bodyText: "Collaboration production smoke base body.",
      databaseUrl,
      documentId: SMOKE_DOCUMENT_ID,
      title: "Production Smoke Document",
      workspaceId: SMOKE_WORKSPACE_ID,
    });
    reportPhase("seed", "ok");

    reportPhase("start_sidecar", "running");
    sidecarServer = spawn(
      process.execPath,
      [resolve(APP_ROOT, COLLABORATION_SERVER_ARTIFACT)],
      {
        cwd: APP_ROOT,
        detached: process.platform !== "win32",
        env: sidecar,
        stdio: "ignore",
      },
    );
    const sidecarHttpUrl = `http://127.0.0.1:${String(sidecarPort)}`;
    const sidecarWebSocketUrl = `ws://127.0.0.1:${String(sidecarPort)}`;
    await waitForSidecarReady(sidecarHttpUrl, TIMEOUTS.readinessMs);
    await withPhaseTimeout(
      assertSidecarHealthContracts(sidecarHttpUrl),
      TIMEOUTS.requestMs * 4,
    );
    reportPhase("start_sidecar", "ok");

    reportPhase("start_web", "running");
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    webServer = spawn(pnpmCommand, ["start"], {
      cwd: APP_ROOT,
      detached: process.platform !== "win32",
      env: web,
      stdio: "ignore",
    });
    const webBaseUrl = `http://127.0.0.1:${String(webPort)}`;
    await waitForWebReadiness(webBaseUrl, waitForChild(webServer));
    reportPhase("start_web", "ok");

    reportPhase("capability_auth", "running");
    await assertExactJsonResponse(
      await fetchSmokeResponse(
        `${webBaseUrl}/api/documents/${encodeURIComponent(SMOKE_DOCUMENT_ID)}/collaboration-capability`,
        { method: "POST" },
      ),
      401,
      { error: "Authentication required" },
      false,
    );
    const allowedOrigin = `http://127.0.0.1:${String(webPort)}`;
    await expectCollaborationConnectionRejected({
      origin: allowedOrigin,
      room: issueSmokeCapability(keyRings.signingRing, "principal:rejected").room,
      timeoutMs: TIMEOUTS.requestMs,
      token: "not-a-capability",
      url: sidecarWebSocketUrl,
    });
    await expectCollaborationConnectionRejected({
      origin: "http://forbidden-origin.example",
      room: issueSmokeCapability(keyRings.signingRing, "principal:rejected").room,
      timeoutMs: TIMEOUTS.requestMs,
      token: await issueSmokeCapability(keyRings.signingRing, "principal:rejected").token(),
      url: sidecarWebSocketUrl,
    });
    reportPhase("capability_auth", "ok");

    reportPhase("convergence", "running");
    const writerCapability = issueSmokeCapability(keyRings.signingRing, "principal:writer");
    const observerCapability = issueSmokeCapability(keyRings.signingRing, "principal:observer");
    const writer = await connectCollaborationClient({
      origin: allowedOrigin,
      room: writerCapability.room,
      timeoutMs: TIMEOUTS.convergenceMs,
      token: await writerCapability.token(),
      url: sidecarWebSocketUrl,
    });
    const observer = await connectCollaborationClient({
      origin: allowedOrigin,
      room: observerCapability.room,
      timeoutMs: TIMEOUTS.convergenceMs,
      token: await observerCapability.token(),
      url: sidecarWebSocketUrl,
    });
    clients.push(writer, observer);
    writer.document.getText(COLLABORATION_TITLE_NAME).insert(0, "smoke-");
    await withPhaseTimeout((async () => {
      while (!observer.title().includes("smoke-")) await delay(50);
    })(), TIMEOUTS.convergenceMs);
    for (const client of clients.splice(0)) client.destroy();
    reportPhase("convergence", "ok");

    reportPhase("drain", "running");
    await assertGracefulSidecarDrain(sidecarServer);
    sidecarServer = undefined;
    await waitForPortRelease(sidecarPort);
    reportPhase("drain", "ok");
  } finally {
    await runCleanupSteps([
      async () => {
        for (const client of clients.splice(0)) client.destroy();
      },
      async () => {
        if (sidecarServer) await stopProcessTree(sidecarServer);
      },
      async () => {
        if (webServer) await stopProcessTree(webServer);
      },
      async () => {
        if (sidecarPort !== undefined) await waitForPortRelease(sidecarPort);
      },
      async () => {
        if (webPort !== undefined) await waitForPortRelease(webPort);
      },
      async () => {
        await rm(temporaryDirectory, { force: true, recursive: true });
      },
    ]);
  }
}

function issueSmokeCapability(signingRing: string, principalId: string) {
  return createCollaborationCapabilityIssuer(signingRing)({
    documentId: SMOKE_DOCUMENT_ID,
    principalId,
    workspaceId: SMOKE_WORKSPACE_ID,
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function reportPhase(phase: string, status: "ok" | "running") {
  console.log(JSON.stringify({ phase, status }));
}

async function main() {
  try {
    await runCollaborationProductionSmoke();
    console.log(JSON.stringify({ status: "ok" }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
