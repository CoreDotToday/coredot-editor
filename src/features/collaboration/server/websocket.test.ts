// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";

import { generateKeyPair, exportJWK } from "jose";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Awareness } from "y-protocols/awareness";
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
import { COLLABORATION_WORKFLOW_CHANGED_PAYLOAD } from "../workflow-notification";
import { createHocuspocusProviderAdapter } from "../client/hocuspocus-provider-adapter";
import { createCollaborationSessionStore } from "../client/session-store";
import { createCollaborationSidecar } from "./create-server";
import { createCollaborationResourceRegistry } from "./resource-limits";

class OriginWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { headers: { Origin: "http://127.0.0.1" } });
  }
}

const workspaceId = "workspace:sidecar-test";
const documentId = "document:sidecar-test";
const room = createCollaborationRoomName({ documentId, generation: 1, workspaceId });

describe("the pinned Hocuspocus durable message lifecycle", () => {
  it("lets a durable server command notify the exact loaded room without exposing workflow state", async () => {
    const fixture = await createFixture({ append: async (input) => receipt(input) });
    try {
      const peer = await fixture.connect("principal:command-workflow-peer");
      const peerStateless = vi.fn();
      peer.provider.on("stateless", peerStateless);

      fixture.publishWorkflowChanged();

      await eventually(() => expect(peerStateless).toHaveBeenCalledWith({
        payload: COLLABORATION_WORKFLOW_CHANGED_PAYLOAD,
      }));
    } finally {
      await fixture.destroy();
    }
  });

  it("broadcasts only a bounded server-owned workflow notification after durable invalidation", async () => {
    const fixture = await createFixture({
      append: async (input) => ({
        ...receipt(input),
        workflowChanged: updateContainsText(input.update, "invalidate approval"),
      }),
    });
    try {
      const writer = await fixture.connect("principal:workflow-writer");
      const peer = await fixture.connect("principal:workflow-peer");
      const peerStateless = vi.fn();
      peer.provider.on("stateless", peerStateless);

      writer.document.getText("test").insert(0, "invalidate approval");

      await eventually(() => expect(peerStateless).toHaveBeenCalledWith({
        payload: COLLABORATION_WORKFLOW_CHANGED_PAYLOAD,
      }));
      expect(COLLABORATION_WORKFLOW_CHANGED_PAYLOAD.length).toBeLessThanOrEqual(64);
    } finally {
      await fixture.destroy();
    }
  });

  it("rejects client stateless attempts instead of rebroadcasting a spoofed workflow signal", async () => {
    const fixture = await createFixture({
      append: async (input) => ({
        ...receipt(input),
        workflowChanged: updateContainsText(input.update, "real server notification"),
      }),
    });
    try {
      const writer = await fixture.connect("principal:stateless-spoofer");
      const validWriter = await fixture.connect("principal:workflow-writer");
      const peer = await fixture.connect("principal:stateless-peer");
      const peerStateless = vi.fn();
      const writerClosed = vi.fn();
      peer.provider.on("stateless", peerStateless);
      writer.provider.on("close", writerClosed);

      writer.provider.sendStateless(COLLABORATION_WORKFLOW_CHANGED_PAYLOAD);
      await eventually(() => expect(writerClosed).toHaveBeenCalled());
      expect(peerStateless).not.toHaveBeenCalled();

      validWriter.document.getText("test").insert(0, "real server notification");

      await eventually(() => expect(peerStateless).toHaveBeenCalledOnce());
      expect(peerStateless).toHaveBeenCalledWith({
        payload: COLLABORATION_WORKFLOW_CHANGED_PAYLOAD,
      });
    } finally {
      await fixture.destroy();
    }
  });
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

  it("releases every concurrent reservation exactly once when a shared room load fails", async () => {
    const load = deferred<void>();
    const resources = createCollaborationResourceRegistry();
    const reserveConnection = vi.spyOn(resources, "reserveConnection");
    const releaseConnection = vi.spyOn(resources, "releaseConnection");
    const beforeLoad = vi.fn(() => load.promise);
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      beforeLoad,
      resourceRegistry: resources,
    });
    try {
      const attempts = [
        fixture.connect("principal:load-failure-a"),
        fixture.connect("principal:load-failure-b"),
      ];
      await eventually(() => {
        expect(reserveConnection).toHaveBeenCalledTimes(2);
        expect(beforeLoad).toHaveBeenCalledTimes(1);
      });

      load.reject(new Error("shared load failed"));
      const outcomes = await Promise.allSettled(attempts);
      expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
      await eventually(() => expect(releaseConnection).toHaveBeenCalledTimes(2));

      await fixture.destroy();
      expect(reserveConnection).toHaveBeenCalledTimes(2);
      expect(releaseConnection).toHaveBeenCalledTimes(2);
    } finally {
      load.reject(new Error("shared load failed"));
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

  it("waits for an in-flight durable append before checkpointing during drain", async () => {
    const append = deferred<DurableUpdateReceipt>();
    const fixture = await createFixture({
      append: (input) => hasYjsChanges(input.update)
        ? append.promise
        : Promise.resolve(receipt(input, 0)),
    });
    try {
      const writer = await fixture.connect("principal:in-flight-drain");
      writer.document.getText("test").insert(0, "finish before checkpoint");
      await eventually(() => expect(fixture.changedAppendInputs).toHaveLength(1));

      const draining = fixture.beginDrain();
      await Promise.resolve();
      expect(fixture.checkpointInputs).toEqual([]);

      append.resolve(receipt(fixture.changedAppendInputs[0]!));
      await draining;
      expect(fixture.checkpointInputs).toEqual([{
        documentId,
        generation: 1,
        workspaceId,
      }]);
    } finally {
      append.resolve(receipt({ generation: 1 } as AppendCollaborationUpdate));
      await fixture.destroy();
    }
  });

  it("bounds destroy across a stuck checkpoint and surfaces checkpoint rejection", async () => {
    const checkpoint = deferred<void>();
    const stuck = await createFixture({
      append: async (input) => receipt(input),
      checkpoint: () => checkpoint.promise,
      shutdownGraceMs: 25,
    });
    try {
      await stuck.connect("principal:stuck-checkpoint");
      const startedAt = performance.now();
      const destroyed = stuck.destroySidecar().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      const outcome = await Promise.race([
        destroyed,
        new Promise<{ status: "timeout" }>((resolve) => setTimeout(
          () => resolve({ status: "timeout" }),
          250,
        )),
      ]);
      expect(outcome).toMatchObject({
        error: expect.objectContaining({ category: "grace_exceeded" }),
        status: "rejected",
      });
      expect(performance.now() - startedAt).toBeLessThan(100);
    } finally {
      checkpoint.resolve();
      await stuck.destroy();
    }

    const failure = new Error("checkpoint failed");
    const rejected = await createFixture({
      append: async (input) => receipt(input),
      checkpoint: async () => {
        throw failure;
      },
      shutdownGraceMs: 100,
    });
    try {
      await rejected.connect("principal:rejected-checkpoint");
      await expect(rejected.destroySidecar()).rejects.toMatchObject({
        category: "checkpoint_failed",
        message: "Collaboration sidecar shutdown failed",
      });
      await expect(rejected.destroySidecar()).rejects.not.toThrow("checkpoint failed");
    } finally {
      await rejected.destroy();
    }
  });

  it("covers beginDrain sync work, checkpoint, and destroy with one shutdown grace", async () => {
    const lifecycle: string[] = [];
    let elapsed = 0;
    const shutdownNow = vi.fn(() => {
      lifecycle.push("clock");
      return elapsed;
    });
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      async checkpoint() {
        lifecycle.push("checkpoint");
        elapsed = 1_001;
      },
      onDocumentKeys() {
        lifecycle.push("beginDrain");
        if (elapsed === 0) elapsed = 250;
      },
      shutdownGraceMs: 1_000,
      shutdownNow,
    });
    try {
      await fixture.connect("principal:whole-shutdown-grace");
      await expect(fixture.destroySidecar()).rejects.toMatchObject({
        category: "grace_exceeded",
        message: "Collaboration sidecar shutdown failed",
      });
      expect(shutdownNow).toHaveBeenCalledTimes(3);
      expect(lifecycle.slice(0, 2)).toEqual(["clock", "beginDrain"]);
      expect(lifecycle).toContain("checkpoint");
    } finally {
      await fixture.destroy();
    }
  });

  it("releases the exact loaded-document reservation after the last disconnect unloads it", async () => {
    const resources = createCollaborationResourceRegistry();
    const releaseDocument = vi.spyOn(resources, "releaseDocument");
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      resourceRegistry: resources,
    });
    try {
      const connected = await fixture.connect("principal:resource-release");
      connected.provider.destroy();

      await eventually(() => expect(releaseDocument).toHaveBeenCalledWith(room));
    } finally {
      await fixture.destroy();
    }
  });

  it("closes the exact room when a durable gateway update exceeds resident growth", async () => {
    const resources = createCollaborationResourceRegistry();
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      resourceRegistry: resources,
    });
    try {
      const connected = await fixture.connect("principal:gateway-growth");
      const closed = vi.fn();
      connected.provider.on("close", closed);
      vi.spyOn(resources, "reserveDocumentGrowth").mockImplementationOnce(() => {
        throw new Error("limit detail");
      });

      expect(() => fixture.publishDurableUpdate(createUpdate("durable gateway")))
        .toThrowError(expect.objectContaining({ reason: "update_rejected" }));
      await eventually(() => expect(closed).toHaveBeenCalledWith({
        event: { code: 1000, reason: "resource_limit" },
      }));
    } finally {
      await fixture.destroy();
    }
  });

  it("keeps clock-zero awareness a no-op and broadcasts only canonical owned presence", async () => {
    const fixture = await createFixture({
      append: async (input) => receipt(input),
    });
    try {
      const writer = await fixture.connect("principal:awareness-writer", { awareness: true });
      const peer = await fixture.connect("principal:awareness-peer", { awareness: true });
      if (!writer.awareness || !peer.awareness) throw new Error("awareness fixture unavailable");

      // Awareness starts at clock zero. The server must keep that protocol
      // no-op as a no-op without creating a ghost participant or closing it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect([...peer.awareness.getStates().keys()]).toEqual([peer.document.clientID]);

      const cursor = {
        anchor: { assoc: 0, tname: "body" },
        head: { assoc: 0, tname: "body" },
      };
      writer.awareness.setLocalState({
        cursor,
        user: { displayName: "Administrator", principalId: "principal:spoof" },
      });
      await eventually(() => expect(peer.awareness?.getStates().get(writer.document.clientID))
        .toEqual({
          cursor,
          user: expectedAwarenessUser("principal:awareness-writer", writer.sessionId),
        }));
      expect([...peer.awareness.getStates().keys()].toSorted((a, b) => a - b)).toEqual(
        [peer.document.clientID, writer.document.clientID].toSorted((a, b) => a - b),
      );

      writer.awareness.setLocalState(null);
      await eventually(() => expect([...peer.awareness!.getStates().keys()])
        .toEqual([peer.document.clientID]));

      writer.awareness.setLocalState({ user: { principalId: "principal:spoof-again" } });
      await eventually(() => expect(
        peer.awareness?.getStates().has(writer.document.clientID),
      ).toBe(true));
      writer.provider.destroy();
      writer.websocketProvider.destroy();
      await eventually(() => expect([...peer.awareness!.getStates().keys()])
        .toEqual([peer.document.clientID]));

      peer.document.getText("test").insert(0, "peer stayed connected");
      await eventually(() => expect(peer.provider.hasUnsyncedChanges).toBe(false));
    } finally {
      await fixture.destroy();
    }
  });

  it("uses the real provider websocket reconnect lifecycle for refresh, downgrade, and destroy", async () => {
    const fixture = await createFixture({ append: async (input) => receipt(input) });
    try {
      await withOriginWebSocket(async () => {
        const sessionId = randomUUID();
        const issued = [
          await fixture.issueCapability("principal:adapter-refresh", "write", sessionId),
          await fixture.issueCapability("principal:adapter-refresh", "write", sessionId),
          await fixture.issueCapability("principal:adapter-refresh", "read", sessionId),
        ];
        const store = createCollaborationSessionStore();
        const session = createHocuspocusProviderAdapter({
          document: new Y.Doc(),
          issueCapability: async () => {
            const next = issued.shift();
            if (!next) throw new Error("no capability configured");
            return next;
          },
          room,
          store,
          url: fixture.webSocketUrl,
        });
        try {
          await session.connect();
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            status: "synced",
            writable: true,
          }));
          const provider = session.provider;
          if (!provider) throw new Error("real provider unavailable");
          const destroy = vi.spyOn(provider, "destroy");

          const writeRefresh = session.refreshCapability();
          expect(store.getSnapshot().writable).toBe(false);
          await writeRefresh;
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            permission: "write",
            status: "synced",
            writable: true,
          }));

          await session.refreshCapability();
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            permission: "read",
            status: "read_only",
            writable: false,
          }));

          session.destroy();
          session.destroy();
          expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
          session.destroy();
        }
      });
    } finally {
      await fixture.destroy();
    }
  });

  it("does not let a disconnected auto-retry regain old write authority during slow refresh", async () => {
    const authorityReads: string[] = [];
    const fixture = await createFixture({
      append: async (input) => receipt(input),
      onCapabilityAuthorityRead: (principalId) => authorityReads.push(principalId),
    });
    const principalId = "principal:adapter-disconnected-refresh";
    const sessionId = randomUUID();
    const initial = await fixture.issueCapability(principalId, "write", sessionId);
    const readCapability = await fixture.issueCapability(principalId, "read", sessionId);
    const refreshed = deferred<Awaited<ReturnType<typeof fixture.issueCapability>>>();
    try {
      await withOriginWebSocket(async () => {
        const issueCapability = vi.fn(async () => (
          issueCapability.mock.calls.length === 1 ? initial : refreshed.promise
        ));
        const store = createCollaborationSessionStore();
        const session = createHocuspocusProviderAdapter({
          document: new Y.Doc(),
          issueCapability,
          room,
          store,
          url: fixture.webSocketUrl,
        });
        try {
          await session.connect();
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            permission: "write",
            status: "synced",
            writable: true,
          }));
          const initialAuthorityReadCount = authorityReads.length;
          expect(initialAuthorityReadCount).toBeGreaterThan(0);

          const websocketProvider = session.provider?.configuration.websocketProvider;
          if (!websocketProvider?.webSocket) throw new Error("real websocket unavailable");
          websocketProvider.webSocket.close();
          await eventually(() => expect(websocketProvider.status).toBe("disconnected"));

          const refreshing = session.refreshCapability();
          void refreshing.catch(() => undefined);
          await eventually(() => expect(issueCapability).toHaveBeenCalledTimes(2));
          expect(store.getSnapshot()).toMatchObject({
            permission: null,
            status: "reconnecting",
            writable: false,
          });

          await new Promise((resolve) => setTimeout(resolve, 1_250));

          expect(store.getSnapshot()).toMatchObject({
            permission: null,
            writable: false,
          });
          expect(authorityReads).toHaveLength(initialAuthorityReadCount);
          expect(fixture.changedAppendInputs).toEqual([]);

          refreshed.resolve(readCapability);
          await refreshing;
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            permission: "read",
            status: "read_only",
            writable: false,
          }));
          expect(authorityReads.length).toBeGreaterThan(initialAuthorityReadCount);
          expect(authorityReads).toEqual(authorityReads.map(() => principalId));
        } finally {
          session.destroy();
        }
      });
    } finally {
      refreshed.resolve(readCapability);
      await fixture.destroy();
    }
  });

  it("keeps real pending state behind the reconnect SyncStep2 durable barrier", async () => {
    const append = deferred<DurableUpdateReceipt>();
    let changedAttempt = 0;
    const fixture = await createFixture({
      append: async (input) => {
        if (!hasYjsChanges(input.update)) return receipt(input, 0);
        changedAttempt += 1;
        return changedAttempt === 1 ? append.promise : receipt(input, changedAttempt);
      },
    });
    try {
      await withOriginWebSocket(async () => {
        const sessionId = randomUUID();
        const initial = await fixture.issueCapability("principal:adapter-pending", "write", sessionId);
        const refreshed = deferred<typeof initial>();
        const issueCapability = vi.fn(async () => (
          issueCapability.mock.calls.length === 1 ? initial : refreshed.promise
        ));
        const store = createCollaborationSessionStore();
        const document = new Y.Doc();
        const session = createHocuspocusProviderAdapter({
          checksum: async () => "d".repeat(64),
          document,
          issueCapability,
          room,
          store,
          url: fixture.webSocketUrl,
        });
        try {
          await session.connect();
          await eventually(() => expect(store.getSnapshot().writable).toBe(true));
          const refreshing = session.refreshCapability();
          await eventually(() => expect(issueCapability).toHaveBeenCalledTimes(2));

          document.getText("test").insert(0, "survives refresh");
          await eventually(() => expect(
            store.getSnapshot().pendingDurableAcknowledgementChecksums,
          ).toEqual(["d".repeat(64)]));

          refreshed.resolve(await fixture.issueCapability(
            "principal:adapter-pending",
            "write",
            sessionId,
          ));
          await refreshing;
          await eventually(() => expect(changedAttempt).toBe(1));
          expect(store.getSnapshot().pendingDurableAcknowledgementChecksums)
            .toEqual(["d".repeat(64)]);

          append.resolve(receipt(fixture.changedAppendInputs[0]!));
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            pendingDurableAcknowledgementChecksums: [],
            status: "synced",
            writable: true,
          }));
        } finally {
          append.resolve(receipt({ generation: 1 } as AppendCollaborationUpdate));
          session.destroy();
        }
      });
    } finally {
      await fixture.destroy();
    }
  });

  it("fails closed and destroys the real provider when refreshed authentication is rejected", async () => {
    const fixture = await createFixture({ append: async (input) => receipt(input) });
    try {
      await withOriginWebSocket(async () => {
        const sessionId = randomUUID();
        const issued = [
          await fixture.issueCapability("principal:adapter-rejected", "write", sessionId),
          { expiresInSeconds: 60, room, token: "rejected-token" },
        ];
        const store = createCollaborationSessionStore();
        const session = createHocuspocusProviderAdapter({
          document: new Y.Doc(),
          issueCapability: async () => {
            const next = issued.shift();
            if (!next) throw new Error("no capability configured");
            return next;
          },
          room,
          store,
          url: fixture.webSocketUrl,
        });
        try {
          await session.connect();
          await eventually(() => expect(store.getSnapshot().writable).toBe(true));
          const provider = session.provider;
          if (!provider) throw new Error("real provider unavailable");
          const destroy = vi.spyOn(provider, "destroy");

          await session.refreshCapability().catch(() => undefined);
          await eventually(() => expect(store.getSnapshot()).toMatchObject({
            status: "fatal",
            writable: false,
          }));
          expect(session.provider).toBeNull();
          expect(destroy).toHaveBeenCalledTimes(1);
          session.destroy();
          expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
          session.destroy();
        }
      });
    } finally {
      await fixture.destroy();
    }
  });

});

async function createFixture(options: {
  append(input: AppendCollaborationUpdate): Promise<DurableUpdateReceipt>;
  beforeLoad?: () => Promise<void>;
  checkpoint?: () => Promise<void>;
  onCapabilityAuthorityRead?: (principalId: string) => void;
  onDocumentKeys?: () => void;
  resourceRegistry?: ReturnType<typeof createCollaborationResourceRegistry>;
  shutdownGraceMs?: number;
  shutdownNow?: () => number;
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
    async appendAuthorizedClientUpdate(_scope, input) {
      appendInputs.push(input);
      return options.append(input);
    },
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
    async findDurableUpdateReplay() {
      return null;
    },
    async initialize() {
      return snapshot;
    },
    async load() {
      await options.beforeLoad?.();
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
        options.onCapabilityAuthorityRead?.(input.principalId);
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
      shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
      verificationKeyRing: verification,
    },
    now,
    persistence,
    readinessChecks: {
      database: async () => true,
      migration: async () => true,
      workers: async () => true,
    },
    resourceRegistry: options.resourceRegistry,
    shutdownNow: options.shutdownNow,
  });
  await sidecar.listen();
  const documentKeys = sidecar.hocuspocus.documents.keys.bind(
    sidecar.hocuspocus.documents,
  );
  sidecar.hocuspocus.documents.keys = () => {
    options.onDocumentKeys?.();
    return documentKeys();
  };

  const providers: HocuspocusProvider[] = [];
  const issueCapability = async (
    principalId: string,
    permission: "read" | "write" = "write",
    sessionId = randomUUID(),
  ) => ({
    expiresInSeconds: 60,
    room,
    token: await issuer.issue({
      authorizationEpoch: 0,
      documentId,
      permission,
      principalId,
      room,
      sessionId,
      workspaceId,
    }),
  });
  return {
    appendInputs,
    beginDrain: sidecar.beginDrain,
    checkpointInputs,
    get changedAppendInputs() {
      return appendInputs.filter((input) => hasYjsChanges(input.update));
    },
    async connect(principalId: string, connectOptions: { awareness?: boolean } = {}) {
      const sessionId = randomUUID();
      const { token } = await issueCapability(principalId, "write", sessionId);
      const document = new Y.Doc();
      const awareness = connectOptions.awareness ? new Awareness(document) : null;
      const websocketProvider = new HocuspocusProviderWebsocket({
        WebSocketPolyfill: OriginWebSocket,
        url: sidecar.webSocketUrl,
      });
      const events: string[] = [];
      const provider = new HocuspocusProvider({
        awareness,
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
      return { awareness, document, provider, sessionId, websocketProvider };
    },
    async destroy() {
      for (const provider of providers) provider.destroy();
      await sidecar.destroy().catch(() => undefined);
    },
    destroySidecar: sidecar.destroy,
    httpUrl: sidecar.httpUrl,
    issueCapability,
    publishDurableUpdate(update: Uint8Array) {
      return sidecar.publishDurableUpdate({ workspaceId }, documentId, 1, update);
    },
    publishWorkflowChanged() {
      return sidecar.publishWorkflowChanged({ workspaceId }, documentId, 1);
    },
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
    workflowChanged: false,
  };
}

function hasYjsChanges(update: Uint8Array) {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

function updateContainsText(update: Uint8Array, expected: string) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, update);
    return document.getText("test").toString().includes(expected);
  } finally {
    document.destroy();
  }
}

function createUpdate(value: string) {
  const document = new Y.Doc();
  document.getText("test").insert(0, value);
  return Y.encodeStateAsUpdate(document);
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

async function withOriginWebSocket<T>(callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: OriginWebSocket,
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
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
function expectedAwarenessUser(principalId: string, sessionId: string) {
  const digest = createHash("sha256").update(principalId).digest();
  const colors = ["#1D4ED8", "#047857", "#7C3AED", "#B45309", "#BE123C"] as const;
  return {
    color: colors[digest[2]! % colors.length],
    displayName: `Participant ${digest.subarray(0, 2).toString("hex").toUpperCase()}`,
    principalId,
    sessionId,
  };
}
