import { generateKeyPair, exportJWK } from "jose";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import {
  createCollaborationCapabilityAuthority,
  type CollaborationCapabilitySigningKeyRing,
  type CollaborationCapabilityVerificationKeyRing,
} from "../capability";
import type {
  AppendCollaborationUpdate,
  CollaborationPersistence,
  CollaborationSnapshot,
  DurableUpdateReceipt,
} from "../persistence";
import { createCollaborationRoomName } from "../room-name";
import { createCollaborationSidecar } from "./create-server";

class OriginWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { headers: { Origin: "http://127.0.0.1" } });
  }
}

const workspaceId = "workspace:sidecar-test";
const documentId = "document:sidecar-test";
const room = createCollaborationRoomName({ documentId, generation: 1, workspaceId });

describe("the pinned Hocuspocus durable message lifecycle", () => {
  it("awaits the durable append before a peer can observe the Yjs update", async () => {
    const appendGate = deferred<DurableUpdateReceipt>();
    const fixture = await createFixture({
      append: (input) => hasYjsChanges(input.update)
        ? appendGate.promise
        : Promise.resolve(receipt(input, 0)),
    });
    try {
      const writer = await fixture.connect("principal:writer");
      const peer = await fixture.connect("principal:peer");
      const baseline = fixture.changedAppendInputs.length;

      writer.document.getText("test").insert(0, "durable first");

      await eventually(() => expect(fixture.changedAppendInputs).toHaveLength(baseline + 1));
      expect(peer.document.getText("test").toString()).toBe("");

      appendGate.resolve(receipt(fixture.changedAppendInputs[baseline]!));
      await eventually(() => {
        expect(peer.document.getText("test").toString()).toBe("durable first");
      });
    } finally {
      await fixture.destroy();
    }
  });

  it("does not expose a failed append and closes only the offending document connection", async () => {
    const firstChangedAppend = deferred<DurableUpdateReceipt>();
    let changedAttempts = 0;
    const fixture = await createFixture({
      append: (input) => {
        if (!hasYjsChanges(input.update)) return Promise.resolve(receipt(input, 0));
        changedAttempts += 1;
        return changedAttempts === 1
          ? firstChangedAppend.promise
          : Promise.resolve(receipt(input, changedAttempts));
      },
    });
    try {
      const writer = await fixture.connect("principal:writer");
      const peer = await fixture.connect("principal:peer");
      const observer = await fixture.connect("principal:observer");
      const writerClose = vi.fn();
      const peerClose = vi.fn();
      writer.provider.on("close", writerClose);
      peer.provider.on("close", peerClose);

      writer.document.getText("test").insert(0, "must not leak");
      await eventually(() => expect(changedAttempts).toBe(1));
      firstChangedAppend.reject(new Error("database secret: must not escape"));

      await eventually(() => {
        expect(writerClose).toHaveBeenCalledWith({
          event: { code: 1000, reason: "storage_unavailable" },
        });
      });
      expect(peer.document.getText("test").toString()).toBe("");
      expect(observer.document.getText("test").toString()).toBe("");
      expect(peerClose).not.toHaveBeenCalled();

      peer.document.getText("test").insert(0, "peer remains connected");
      await eventually(() => {
        expect(changedAttempts).toBe(2);
        expect(peer.provider.hasUnsyncedChanges).toBe(false);
        expect(observer.document.getText("test").toString()).toBe("peer remains connected");
      });
    } finally {
      await fixture.destroy();
    }
  });

  it("marks readiness down, rejects upgrades, closes rooms, and checkpoints before drain completes", async () => {
    const checkpoint = deferred<void>();
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      checkpoint: () => checkpoint.promise,
    });
    try {
      const connected = await fixture.connect("principal:drain");
      const closed = vi.fn();
      connected.provider.on("close", closed);
      expect((await fetch(`${fixture.httpUrl}/ready`)).status).toBe(200);

      const draining = fixture.beginDrain();

      await eventually(() => expect(closed).toHaveBeenCalledWith({
        event: { code: 1000, reason: "server_draining" },
      }));
      expect((await fetch(`${fixture.httpUrl}/ready`)).status).toBe(503);
      await expectUpgradeRejected(fixture.webSocketUrl);
      expect(fixture.checkpointInputs).toEqual([{
        documentId,
        generation: 1,
        workspaceId,
      }]);

      checkpoint.resolve();
      await draining;
    } finally {
      checkpoint.resolve();
      await fixture.destroy();
    }
  });
});

async function createFixture(options: {
  append(input: AppendCollaborationUpdate): Promise<DurableUpdateReceipt>;
  checkpoint?: () => Promise<void>;
}) {
  const { signing, verification } = await createKeyRings();
  const now = () => new Date("2026-07-19T09:00:00.000Z");
  const issuer = createCollaborationCapabilityAuthority({ now, signingKeyRing: signing });
  const appendInputs: AppendCollaborationUpdate[] = [];
  const checkpointInputs: Array<{
    documentId: string;
    generation: number;
    workspaceId: string;
  }> = [];
  const baseDocument = new Y.Doc();
  const snapshot = createSnapshot(baseDocument);
  const persistence: CollaborationPersistence = {
    async appendValidatedUpdate(_scope, input) {
      appendInputs.push(input);
      return options.append(input);
    },
    async checkpoint(scope, checkpointDocumentId, generation) {
      checkpointInputs.push({
        documentId: checkpointDocumentId,
        generation,
        workspaceId: scope.workspaceId,
      });
      await options.checkpoint?.();
      return {
        checkpointSeq: 0,
        checksum: "c".repeat(64),
        documentId: checkpointDocumentId,
        generation,
        projectedSeq: 0,
      };
    },
    async initialize() {
      return snapshot;
    },
    async load() {
      const document = new Y.Doc();
      Y.applyUpdate(document, Y.encodeStateAsUpdate(baseDocument));
      return { ...snapshot, document };
    },
    async project() {
      throw new Error("not used");
    },
    async withInitializedWrite() {
      throw new Error("not used");
    },
  };
  const sidecar = createCollaborationSidecar({
    authorization: {
      async readCapabilityAuthority(_scope, input) {
        return input.documentId === documentId
          ? { authorizationEpoch: 0, generation: 1 }
          : null;
      },
      async readEpoch() {
        return 0;
      },
    },
    config: {
      address: "127.0.0.1",
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: ["http://127.0.0.1"],
      port: 0,
      shutdownGraceMs: 1_000,
      verificationKeyRing: verification,
    },
    now,
    persistence,
    readinessChecks: {
      database: async () => true,
      migration: async () => true,
      workers: async () => true,
    },
  });
  await sidecar.listen();

  const providers: HocuspocusProvider[] = [];
  return {
    appendInputs,
    beginDrain: sidecar.beginDrain,
    checkpointInputs,
    get changedAppendInputs() {
      return appendInputs.filter((input) => hasYjsChanges(input.update));
    },
    async connect(principalId: string) {
      const sessionId = randomUUID();
      const token = await issuer.issue({
        authorizationEpoch: 0,
        documentId,
        permission: "write",
        principalId,
        room,
        sessionId,
        workspaceId,
      });
      const document = new Y.Doc();
      const websocketProvider = new HocuspocusProviderWebsocket({
        WebSocketPolyfill: OriginWebSocket,
        url: sidecar.webSocketUrl,
      });
      const events: string[] = [];
      const provider = new HocuspocusProvider({
        awareness: null,
        document,
        name: room,
        onAuthenticated: () => events.push("authenticated"),
        onAuthenticationFailed: ({ reason }) => events.push(`authentication_failed:${reason}`),
        onClose: ({ event }) => events.push(`closed:${event.reason}`),
        onOpen: () => events.push("opened"),
        onStatus: ({ status }) => events.push(`status:${status}`),
        token,
        websocketProvider,
      });
      providers.push(provider);
      provider.attach();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(
          `provider did not sync: ${events.join(",")}`,
        )), 3_000);
        provider.on("synced", () => {
          clearTimeout(timeout);
          resolve();
        });
        provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
          clearTimeout(timeout);
          reject(new Error(`authentication failed: ${reason}`));
        });
      });
      return { document, provider };
    },
    async destroy() {
      for (const provider of providers) provider.destroy();
      await sidecar.destroy();
    },
    httpUrl: sidecar.httpUrl,
    webSocketUrl: sidecar.webSocketUrl,
  };
}

function createSnapshot(document: Y.Doc): CollaborationSnapshot {
  return {
    checkpointSeq: 0,
    document,
    documentId,
    generation: 1,
    headSeq: 0,
    projectedSeq: 0,
    schemaFingerprint: "a".repeat(64),
    schemaVersion: 1,
  };
}

function receipt(input: AppendCollaborationUpdate, headSeq = 1): DurableUpdateReceipt {
  return {
    checksum: "b".repeat(64),
    documentId,
    generation: input.generation,
    headSeq,
    seq: headSeq,
  };
}

function hasYjsChanges(update: Uint8Array) {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

async function createKeyRings(): Promise<{
  signing: CollaborationCapabilitySigningKeyRing;
  verification: CollaborationCapabilityVerificationKeyRing;
}> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = "sidecar-test-key";
  return {
    signing: {
      activeKid: kid,
      keys: [{
        alg: "ES256",
        kid,
        privateJwk: await exportJWK(privateKey) as Record<string, unknown>,
      }],
    },
    verification: {
      keys: [{
        alg: "ES256",
        kid,
        publicJwk: await exportJWK(publicKey) as Record<string, unknown>,
      }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function eventually(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw failure;
}

async function expectUpgradeRejected(url: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new OriginWebSocket(url);
    const timeout = setTimeout(() => reject(new Error("upgrade was not rejected")), 1_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      expect(response.statusCode).toBe(403);
      response.resume();
      resolve();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("draining sidecar accepted an upgrade"));
    });
    socket.once("error", () => undefined);
  });
}
// @vitest-environment node

import { randomUUID } from "node:crypto";
