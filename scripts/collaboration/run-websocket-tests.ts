import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { exportJWK, generateKeyPair } from "jose";
import WebSocket from "ws";
import * as Y from "yjs";

import { APP_ROOT } from "../../src/db/url";
import {
  createCollaborationCapabilityAuthority,
  parseCollaborationCapabilitySigningKeyRing,
} from "../../src/features/collaboration/capability";
import { COLLABORATION_TITLE_NAME } from "../../src/features/collaboration/contracts";
import { createCollaborationRoomName } from "../../src/features/collaboration/room-name";
import {
  inheritedToolEnvironmentNames,
  reserveAvailablePort,
  runCommand,
  stopProcessTree,
  waitForChild,
  waitForPortRelease,
} from "../e2e/run-production-smoke";
import { COLLABORATION_SERVER_ARTIFACT } from "./build-server";

const TIMEOUTS = Object.freeze({
  buildMs: 180_000,
  migrateMs: 60_000,
  requestMs: 5_000,
  scenarioMs: 20_000,
  shutdownMs: 15_000,
  startupMs: 30_000,
});

export const WEBSOCKET_TEST_ORIGIN = "http://127.0.0.1:3000";

export type CollaborationCapabilityKeyRings = {
  signingRing: string;
  verificationRing: string;
};

let seededDatabaseUrl: string | undefined;

export async function createCollaborationCapabilityKeyRings(
  kid = "collaboration-harness",
): Promise<CollaborationCapabilityKeyRings> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    signingRing: JSON.stringify({
      activeKid: kid,
      keys: [{ alg: "ES256", kid, privateJwk: await exportJWK(privateKey) }],
    }),
    verificationRing: JSON.stringify({
      keys: [{ alg: "ES256", kid, publicJwk: await exportJWK(publicKey) }],
    }),
  };
}

export function createCollaborationCapabilityIssuer(signingRing: string) {
  const authority = createCollaborationCapabilityAuthority({
    signingKeyRing: parseCollaborationCapabilitySigningKeyRing(signingRing),
  });
  return (input: {
    authorizationEpoch?: number;
    documentId: string;
    permission?: "read" | "write";
    principalId: string;
    sessionId?: string;
    workspaceId: string;
  }) => {
    const room = createCollaborationRoomName({
      documentId: input.documentId,
      generation: 1,
      workspaceId: input.workspaceId,
    });
    return {
      room,
      async token() {
        return authority.issue({
          authorizationEpoch: input.authorizationEpoch ?? 0,
          documentId: input.documentId,
          permission: input.permission ?? "write",
          principalId: input.principalId,
          room,
          sessionId: input.sessionId ?? randomUUID(),
          workspaceId: input.workspaceId,
        });
      },
    };
  };
}

/**
 * Seeds one draft document and initializes its collaboration generation inside
 * the harness database. The database URL is bound process-wide on first use so
 * the shared application client can never write outside the isolated file.
 */
export async function seedInitializedCollaborationDocument(input: {
  bodyText: string;
  databaseUrl: string;
  documentId: string;
  title: string;
  workspaceId: string;
}) {
  if (seededDatabaseUrl !== undefined && seededDatabaseUrl !== input.databaseUrl) {
    throw harnessFailure();
  }
  seededDatabaseUrl = input.databaseUrl;
  process.env.DATABASE_URL = input.databaseUrl;
  const { db } = await import("../../src/db/client");
  const { documents } = await import("../../src/db/schema");
  const { createCollaborationPersistence } = await import(
    "../../src/features/collaboration/persistence"
  );
  const now = new Date();
  await db.insert(documents).values({
    contentJson: {
      content: [{
        content: [{ text: input.bodyText, type: "text" }],
        type: "paragraph",
      }],
      type: "doc",
    },
    createdAt: now,
    id: input.documentId,
    plainText: input.bodyText,
    title: input.title,
    updatedAt: now,
    workspaceId: input.workspaceId,
  }).onConflictDoNothing();
  const persistence = createCollaborationPersistence(db);
  await persistence.initialize({ workspaceId: input.workspaceId }, input.documentId);
}

export function createOriginWebSocketClass(origin: string) {
  return class OriginWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { Origin: origin } });
    }
  };
}

export type ConnectedCollaborationClient = {
  destroy(): void;
  document: Y.Doc;
  provider: HocuspocusProvider;
  title(): string;
};

export async function connectCollaborationClient(input: {
  origin?: string;
  room: string;
  timeoutMs?: number;
  token: string;
  url: string;
}): Promise<ConnectedCollaborationClient> {
  const outcome = await openProvider(input);
  if (outcome.status !== "synced") {
    outcome.destroy();
    throw harnessFailure();
  }
  return {
    destroy: outcome.destroy,
    document: outcome.document,
    provider: outcome.provider,
    title: () => outcome.document.getText(COLLABORATION_TITLE_NAME).toString(),
  };
}

export async function expectCollaborationConnectionRejected(input: {
  origin?: string;
  room: string;
  timeoutMs?: number;
  token: string;
  url: string;
}) {
  const outcome = await openProvider(input);
  outcome.destroy();
  if (outcome.status !== "rejected") throw harnessFailure();
}

async function openProvider(input: {
  origin?: string;
  room: string;
  timeoutMs?: number;
  token: string;
  url: string;
}) {
  const document = new Y.Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({
    WebSocketPolyfill: createOriginWebSocketClass(input.origin ?? WEBSOCKET_TEST_ORIGIN),
    url: input.url,
  });
  const provider = new HocuspocusProvider({
    document,
    name: input.room,
    token: input.token,
    websocketProvider,
  });
  const destroy = () => {
    try {
      provider.destroy();
    } finally {
      websocketProvider.destroy();
    }
  };
  provider.attach();
  const status = await new Promise<"rejected" | "synced" | "timeout">((resolvePromise) => {
    const timeout = setTimeout(
      () => resolvePromise("timeout"),
      input.timeoutMs ?? TIMEOUTS.scenarioMs,
    );
    const finish = (value: "rejected" | "synced") => {
      clearTimeout(timeout);
      resolvePromise(value);
    };
    provider.on("synced", () => finish("synced"));
    provider.on("authenticationFailed", () => finish("rejected"));
    provider.on("close", () => finish("rejected"));
  });
  if (status === "timeout") {
    destroy();
    throw harnessFailure();
  }
  return { destroy, document, provider, status, websocketProvider };
}

export async function waitForSidecarReady(httpUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await fetch(`${httpUrl}/ready`, { cache: "no-store" })
      .then((response) => response.status === 200)
      .catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw harnessFailure();
}

export function createSidecarEnvironment(
  base: NodeJS.ProcessEnv,
  options: {
    allowedOrigin: string;
    databaseUrl: string;
    port: number;
    verificationRing: string;
  },
) {
  const environment: NodeJS.ProcessEnv = {
    COLLABORATION_ALLOWED_HOSTS: "127.0.0.1",
    COLLABORATION_ALLOWED_ORIGINS: options.allowedOrigin,
    COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: options.verificationRing,
    COLLABORATION_SERVER_ADDRESS: "127.0.0.1",
    COLLABORATION_SERVER_PORT: String(options.port),
    COLLABORATION_SHUTDOWN_GRACE_MS: "10000",
    DATABASE_URL: options.databaseUrl,
    NODE_ENV: "production",
  };
  for (const name of inheritedToolEnvironmentNames) {
    const value = base[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function createToolEnvironment(base: NodeJS.ProcessEnv, databaseUrl: string) {
  const environment = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  environment.DATABASE_URL = databaseUrl;
  for (const name of inheritedToolEnvironmentNames) {
    const value = base[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

type SidecarHandle = {
  child: ChildProcess;
  httpUrl: string;
  webSocketUrl: string;
};

async function startSidecar(
  environment: NodeJS.ProcessEnv,
  port: number,
): Promise<SidecarHandle> {
  const child = spawn(
    process.execPath,
    [resolve(APP_ROOT, COLLABORATION_SERVER_ARTIFACT)],
    {
      cwd: APP_ROOT,
      detached: process.platform !== "win32",
      env: environment,
      stdio: "ignore",
    },
  );
  const httpUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await Promise.race([
      waitForSidecarReady(httpUrl, TIMEOUTS.startupMs),
      waitForChild(child).then(() => {
        throw harnessFailure();
      }),
    ]);
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }
  return { child, httpUrl, webSocketUrl: `ws://127.0.0.1:${String(port)}` };
}

async function stopSidecarGracefully(handle: SidecarHandle, port: number) {
  const exit = waitForChild(handle.child);
  if (!handle.child.kill("SIGTERM")) throw harnessFailure();
  const outcome = await withTimeout(exit, TIMEOUTS.shutdownMs);
  if (outcome.error || outcome.code !== 0 || outcome.signal !== null) {
    throw harnessFailure();
  }
  await waitForPortRelease(port);
}

export async function runCollaborationWebSocketTests() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "coredot-collaboration-ws-"));
  const databaseUrl = `file:${join(temporaryDirectory, "collaboration-ws.db")}`;
  const workspaceId = "workspace:ws-tests";
  const foreignWorkspaceId = "workspace:ws-tests-foreign";
  const documentId = "document:ws-tests";
  let sidecar: SidecarHandle | undefined;
  let port: number | undefined;
  const clients: ConnectedCollaborationClient[] = [];

  try {
    const toolEnvironment = createToolEnvironment(process.env, databaseUrl);
    await runCommand(["collaboration:build"], toolEnvironment, TIMEOUTS.buildMs, "build");
    await runCommand(["db:migrate"], toolEnvironment, TIMEOUTS.migrateMs, "migrate");

    reportPhase("seed", "running");
    await seedInitializedCollaborationDocument({
      bodyText: "Collaboration websocket harness base body.",
      databaseUrl,
      documentId,
      title: "Harness Document",
      workspaceId,
    });
    const keyRings = await createCollaborationCapabilityKeyRings();
    const issue = createCollaborationCapabilityIssuer(keyRings.signingRing);
    reportPhase("seed", "ok");

    port = await reserveAvailablePort();
    const sidecarEnvironment = createSidecarEnvironment(process.env, {
      allowedOrigin: WEBSOCKET_TEST_ORIGIN,
      databaseUrl,
      port,
      verificationRing: keyRings.verificationRing,
    });
    reportPhase("start", "running");
    sidecar = await startSidecar(sidecarEnvironment, port);
    reportPhase("start", "ok");
    const url = sidecar.webSocketUrl;
    const { room } = issue({ documentId, principalId: "principal:a", workspaceId });

    reportPhase("convergence", "running");
    const writerToken = await issue({
      documentId,
      principalId: "principal:a",
      workspaceId,
    }).token();
    const peerToken = await issue({
      documentId,
      principalId: "principal:b",
      workspaceId,
    }).token();
    const writer = await connectCollaborationClient({ room, token: writerToken, url });
    const peer = await connectCollaborationClient({ room, token: peerToken, url });
    clients.push(writer, peer);
    writer.document.getText(COLLABORATION_TITLE_NAME).insert(0, "alpha-");
    peer.document.getText(COLLABORATION_TITLE_NAME).insert(0, "beta-");
    await eventually(() => {
      const writerTitle = writer.title();
      const peerTitle = peer.title();
      if (
        writerTitle !== peerTitle
        || !writerTitle.includes("alpha-")
        || !writerTitle.includes("beta-")
        || !writerTitle.includes("Harness Document")
      ) {
        throw harnessFailure();
      }
    });
    reportPhase("convergence", "ok");

    reportPhase("token_refresh", "running");
    await runTokenRefreshScenario({ documentId, issue, room, url, workspaceId });
    reportPhase("token_refresh", "ok");

    reportPhase("revoked_access", "running");
    const revokedPrincipal = "principal:revoked";
    const revokedToken = await issue({
      documentId,
      principalId: revokedPrincipal,
      workspaceId,
    }).token();
    const revoked = await connectCollaborationClient({ room, token: revokedToken, url });
    clients.push(revoked);
    const revokedClosed = waitForProviderClose(revoked.provider);
    const { createCollaborationAuthorizationRepository } = await import(
      "../../src/features/collaboration/authorization-repository"
    );
    const { db } = await import("../../src/db/client");
    await createCollaborationAuthorizationRepository(db)
      .bumpEpoch({ workspaceId }, revokedPrincipal);
    await expectCollaborationConnectionRejected({
      room,
      timeoutMs: TIMEOUTS.requestMs,
      token: revokedToken,
      url,
    });
    revoked.document.getText(COLLABORATION_TITLE_NAME).insert(0, "must-not-write-");
    await withTimeout(revokedClosed, TIMEOUTS.scenarioMs);
    reportPhase("revoked_access", "ok");

    reportPhase("cross_workspace_tampering", "running");
    const foreignRoom = createCollaborationRoomName({
      documentId,
      generation: 1,
      workspaceId: foreignWorkspaceId,
    });
    const tamperToken = await issue({
      documentId,
      principalId: "principal:tamper",
      workspaceId,
    }).token();
    await expectCollaborationConnectionRejected({
      room: foreignRoom,
      timeoutMs: TIMEOUTS.requestMs,
      token: tamperToken,
      url,
    });
    await expectCollaborationConnectionRejected({
      room,
      timeoutMs: TIMEOUTS.requestMs,
      token: "tampered-token",
      url,
    });
    reportPhase("cross_workspace_tampering", "ok");

    reportPhase("restart_recovery", "running");
    const durableWriterToken = await issue({
      documentId,
      principalId: "principal:durable-writer",
      workspaceId,
    }).token();
    const durableObserverToken = await issue({
      documentId,
      principalId: "principal:durable-observer",
      workspaceId,
    }).token();
    const durableWriter = await connectCollaborationClient({
      room,
      token: durableWriterToken,
      url,
    });
    const durableObserver = await connectCollaborationClient({
      room,
      token: durableObserverToken,
      url,
    });
    clients.push(durableWriter, durableObserver);
    durableWriter.document.getText(COLLABORATION_TITLE_NAME).insert(0, "durable-");
    await eventually(() => {
      if (!durableObserver.title().includes("durable-")) throw harnessFailure();
    });
    for (const client of clients.splice(0)) client.destroy();
    await stopSidecarGracefully(sidecar, port);
    sidecar = await startSidecar(sidecarEnvironment, port);
    const recoveredToken = await issue({
      documentId,
      principalId: "principal:recovered",
      workspaceId,
    }).token();
    const recovered = await connectCollaborationClient({ room, token: recoveredToken, url });
    clients.push(recovered);
    await eventually(() => {
      const title = recovered.title();
      if (
        !title.includes("durable-")
        || !title.includes("alpha-")
        || !title.includes("beta-")
      ) {
        throw harnessFailure();
      }
    });
    reportPhase("restart_recovery", "ok");

    for (const client of clients.splice(0)) client.destroy();
    reportPhase("shutdown", "running");
    await stopSidecarGracefully(sidecar, port);
    sidecar = undefined;
    reportPhase("shutdown", "ok");
  } finally {
    for (const client of clients.splice(0)) {
      try {
        client.destroy();
      } catch {
        // Cleanup remains best effort once a scenario has already failed.
      }
    }
    if (sidecar) await stopProcessTree(sidecar.child);
    if (port !== undefined) await waitForPortRelease(port).catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runTokenRefreshScenario(input: {
  documentId: string;
  issue: ReturnType<typeof createCollaborationCapabilityIssuer>;
  room: string;
  url: string;
  workspaceId: string;
}) {
  const { createHocuspocusProviderAdapter } = await import(
    "../../src/features/collaboration/client/hocuspocus-provider-adapter"
  );
  const { createCollaborationSessionStore } = await import(
    "../../src/features/collaboration/client/session-store"
  );
  const sessionId = randomUUID();
  const principalId = "principal:refresh";
  const issueForPermission = (permission: "read" | "write") => input.issue({
    documentId: input.documentId,
    permission,
    principalId,
    sessionId,
    workspaceId: input.workspaceId,
  }).token();
  const permissions: Array<"read" | "write"> = ["write", "write", "read"];
  const store = createCollaborationSessionStore();
  await withOriginWebSocket(async () => {
    const session = createHocuspocusProviderAdapter({
      document: new Y.Doc(),
      issueCapability: async () => {
        const permission = permissions.shift();
        if (!permission) throw harnessFailure();
        return {
          expiresInSeconds: 60,
          room: input.room,
          token: await issueForPermission(permission),
        };
      },
      room: input.room,
      store,
      url: input.url,
    });
    try {
      await session.connect();
      await eventually(() => {
        const snapshot = store.getSnapshot();
        if (snapshot.status !== "synced" || snapshot.writable !== true) {
          throw harnessFailure();
        }
      });
      await session.refreshCapability();
      await eventually(() => {
        const snapshot = store.getSnapshot();
        if (snapshot.status !== "synced" || snapshot.writable !== true) {
          throw harnessFailure();
        }
      });
      await session.refreshCapability();
      await eventually(() => {
        const snapshot = store.getSnapshot();
        if (snapshot.status !== "read_only" || snapshot.writable !== false) {
          throw harnessFailure();
        }
      });
    } finally {
      session.destroy();
    }
  });
}

function waitForProviderClose(provider: HocuspocusProvider) {
  return new Promise<void>((resolvePromise) => {
    provider.on("close", () => resolvePromise());
  });
}

async function withOriginWebSocket<T>(callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: createOriginWebSocketClass(WEBSOCKET_TEST_ORIGIN),
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
}

async function eventually(assertion: () => void, timeoutMs = TIMEOUTS.scenarioMs) {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown = harnessFailure();
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await delay(25);
    }
  }
  throw failure;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, reject) => {
        timer = setTimeout(() => reject(harnessFailure()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function reportPhase(phase: string, status: "ok" | "running") {
  console.log(JSON.stringify({ phase, status }));
}

function harnessFailure() {
  return new Error("Collaboration websocket tests failed");
}

async function main() {
  try {
    await runCollaborationWebSocketTests();
    console.log(JSON.stringify({ status: "ok" }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
