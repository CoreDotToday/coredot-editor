import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";

import {
  Server,
  type Connection,
  type onUpgradePayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

import type { WorkspaceScope } from "@/features/auth/request-context";

import {
  createCollaborationCapabilityAuthority,
  type CollaborationCapabilityClaims,
} from "../capability";
import type { CollaborationPersistence } from "../persistence";
import {
  createCollaborationRoomName,
  parseCollaborationRoomName,
} from "../room-name";
import { COLLABORATION_WORKFLOW_CHANGED_PAYLOAD } from "../workflow-notification";
import {
  createAwarenessPolicy,
  type VerifiedCollaborationContext,
} from "./awareness-policy";
import {
  COLLABORATION_LIMITS,
  type CollaborationServerConfig,
} from "./config";
import {
  CollaborationConnectionError,
  createDurableUpdateHooks,
} from "./durable-update-hook";
import {
  createCollaborationHealthController,
  type CollaborationReadinessChecks,
} from "./health-server";
import { createCollaborationResourceRegistry } from "./resource-limits";

type CurrentAuthority = { authorizationEpoch: number; generation: number };
type CollaborationAuthorizationReader = {
  readCapabilityAuthority(
    scope: WorkspaceScope,
    input: { documentId: string; principalId: string },
  ): Promise<CurrentAuthority | null>;
  readEpoch(scope: WorkspaceScope, principalId: string): Promise<number>;
};

type SidecarContext = VerifiedCollaborationContext & { reservationKey: string };

const COLORS = ["#1D4ED8", "#047857", "#7C3AED", "#B45309", "#BE123C"] as const;

export type CollaborationShutdownCategory =
  | "checkpoint_failed"
  | "destroy_failed"
  | "grace_exceeded";

export class CollaborationShutdownError extends Error {
  override readonly name = "CollaborationShutdownError";

  constructor(readonly category: CollaborationShutdownCategory) {
    super("Collaboration sidecar shutdown failed");
  }
}

export function createCollaborationSidecar(options: {
  authorization: CollaborationAuthorizationReader;
  config: CollaborationServerConfig;
  now?: () => Date;
  persistence: CollaborationPersistence;
  readinessChecks?: CollaborationReadinessChecks;
  resourceRegistry?: ReturnType<typeof createCollaborationResourceRegistry>;
  shutdownNow?: () => number;
}) {
  const now = options.now ?? (() => new Date());
  const authority = createCollaborationCapabilityAuthority({
    now,
    verificationKeyRing: options.config.verificationKeyRing,
  });
  const awareness = createAwarenessPolicy({ now: () => now().getTime() });
  const blocked = new WeakSet<object>();
  const refreshes = new WeakMap<object, Promise<SidecarContext>>();
  const resources = options.resourceRegistry ?? createCollaborationResourceRegistry();
  const reservationRooms = new Map<string, string>();
  const pendingReservationsByRoom = new Map<string, Set<string>>();
  const trackReservation = (key: string, room: string) => {
    reservationRooms.set(key, room);
    const pending = pendingReservationsByRoom.get(room) ?? new Set<string>();
    pending.add(key);
    pendingReservationsByRoom.set(room, pending);
  };
  const removePendingReservation = (key: string) => {
    const room = reservationRooms.get(key);
    if (!room) return;
    const pending = pendingReservationsByRoom.get(room);
    pending?.delete(key);
    if (pending?.size === 0) pendingReservationsByRoom.delete(room);
  };
  const releaseReservation = (key: string) => {
    if (!reservationRooms.has(key)) return;
    removePendingReservation(key);
    reservationRooms.delete(key);
    return resources.releaseConnection(key);
  };
  const releasePendingRoomReservations = (room: string) => {
    const pending = [...(pendingReservationsByRoom.get(room) ?? [])];
    for (const key of pending) releaseReservation(key);
  };
  const shutdownNow = options.shutdownNow ?? (() => performance.now());
  const health = createCollaborationHealthController({
    checks: options.readinessChecks ?? {
      database: async () => false,
      migration: async () => false,
      workers: async () => false,
    },
  });

  const closeRoomByName = (
    exactRoom: string,
    reason: "archived" | "resource_limit" | "revoked" | "room_rotated" | "schema_changed" | "server_draining",
  ) => {
    const document = server.hocuspocus.documents.get(exactRoom);
    if (!document) return;
    for (const connection of document.getConnections() as Array<Connection<SidecarContext>>) {
      blocked.add(connection);
      connection.close({ code: 4400, reason });
    }
  };
  const publishWorkflowChangedByRoom = (exactRoom: string) => {
    server.hocuspocus.documents.get(exactRoom)?.broadcastStateless(
      COLLABORATION_WORKFLOW_CHANGED_PAYLOAD,
    );
  };
  const durable = createDurableUpdateHooks({
    authorization: options.authorization,
    blocked,
    consumeUpdate: resources.consumeUpdate,
    finishAwareness: awareness.finish,
    isDraining: () => health.isDraining,
    now,
    onDurableApplyInterrupted: (room) => closeRoomByName(room, "room_rotated"),
    onRoomRotated: (room) => closeRoomByName(room, "room_rotated"),
    onWorkflowChanged: publishWorkflowChangedByRoom,
    persistence: options.persistence,
    refreshes,
    reserveDocumentGrowth: resources.reserveDocumentGrowth,
    validateAwareness: awareness.validateFrame,
  });

  const server = new Server<SidecarContext>({
    address: options.config.address,
    maxPendingDocuments: COLLABORATION_LIMITS.maxPendingDocuments,
    maxUnauthenticatedQueueMessages: COLLABORATION_LIMITS.maxUnauthenticatedQueueMessages,
    maxUnauthenticatedQueueSize: COLLABORATION_LIMITS.maxUnauthenticatedQueueSize,
    port: options.config.port,
    quiet: true,
    stopOnSignals: false,
    unloadImmediately: true,
    websocketOptions: { maxPayload: COLLABORATION_LIMITS.websocketPayloadBytes },

    async onUpgrade(payload) {
      if (health.isDraining || !isAllowedUpgrade(payload, options.config)) {
        rejectUpgrade(payload.socket);
        return Promise.reject();
      }
    },

    async onRequest({ request, response }) {
      if (await health.handle(request, response)) return Promise.reject();
    },

    async onAuthenticate(payload) {
      try {
        if (health.isDraining) {
          throw new CollaborationConnectionError("server_draining");
        }
        const verified = await verifyCurrentContext(
          authority,
          options.authorization,
          payload.token,
          payload.documentName,
        );
        if (health.isDraining) {
          throw new CollaborationConnectionError("server_draining");
        }
        const reservationKey = resources.reserveConnection(
          payload.socketId,
          verified,
        );
        trackReservation(reservationKey, payload.documentName);
        payload.connectionConfig.readOnly = verified.permission === "read";
        return { ...verified, reservationKey };
      } catch (error) {
        if (error instanceof CollaborationConnectionError) throw error;
        throw new CollaborationConnectionError("authorization_revoked");
      }
    },

    onTokenSync(payload) {
      const refresh = (async () => {
        try {
          if (health.isDraining) {
            throw new CollaborationConnectionError("server_draining");
          }
          const verified = await verifyCurrentContext(
            authority,
            options.authorization,
            payload.token,
            payload.documentName,
          );
          if (health.isDraining) {
            throw new CollaborationConnectionError("server_draining");
          }
          const previous = payload.connection.context;
          if (
            verified.documentId !== previous.documentId
            || verified.principalId !== previous.principalId
            || verified.room !== previous.room
            || verified.workspaceId !== previous.workspaceId
          ) {
            throw new CollaborationConnectionError("authorization_revoked");
          }
          const next: SidecarContext = {
            ...verified,
            reservationKey: previous.reservationKey,
          };
          payload.connection.context = next;
          payload.connection.readOnly = next.permission === "read";
          payload.connectionConfig.readOnly = next.permission === "read";
          return next;
        } catch (error) {
          blocked.add(payload.connection);
          if (error instanceof CollaborationConnectionError) throw error;
          throw new CollaborationConnectionError("authorization_revoked");
        }
      })();
      refreshes.set(payload.connection, refresh);
      void refresh.finally(() => {
        if (refreshes.get(payload.connection) === refresh) refreshes.delete(payload.connection);
      }).catch(() => undefined);
      return refresh;
    },

    async onLoadDocument({ context, documentName }) {
      try {
        if (health.isDraining) {
          throw new CollaborationConnectionError("server_draining");
        }
        const identity = parseCollaborationRoomName(documentName);
        if (
          identity.documentId !== context.documentId
          || identity.generation !== context.generation
          || identity.workspaceId !== context.workspaceId
        ) {
          throw new CollaborationConnectionError("authorization_revoked");
        }
        const snapshot = await options.persistence.load(
          { workspaceId: context.workspaceId },
          context.documentId,
        );
        if (health.isDraining) {
          throw new CollaborationConnectionError("server_draining");
        }
        if (!snapshot || snapshot.generation !== context.generation) {
          throw new CollaborationConnectionError("room_rotated");
        }
        try {
          const encoded = Y.encodeStateAsUpdate(snapshot.document);
          resources.reserveDocument(documentName, encoded.byteLength);
          return encoded;
        } finally {
          snapshot.document.destroy();
        }
      } catch (error) {
        // Hocuspocus shares one onLoadDocument Promise for concurrent clients.
        // Release every reservation waiting on that room, not only the context
        // of the client that created the shared Promise.
        releasePendingRoomReservations(documentName);
        if (error instanceof CollaborationConnectionError) throw error;
        throw new CollaborationConnectionError("storage_unavailable");
      }
    },

    async connected({ connection, context }) {
      if (health.isDraining) {
        releaseReservation(context.reservationKey);
        throw new CollaborationConnectionError("server_draining");
      }
      resources.attachConnection(context.reservationKey, connection);
      removePendingReservation(context.reservationKey);
    },

    beforeHandleMessage({ connection, update }) {
      return durable.before(connection as Connection<VerifiedCollaborationContext>, update);
    },

    afterHandleMessage({ connection }) {
      return durable.after(connection as Connection<VerifiedCollaborationContext>);
    },

    async beforeHandleAwareness({ connection, context, states }) {
      if (!connection || !context) throw new CollaborationConnectionError("invalid_message");
      awareness.sanitizeStates(connection, context, states);
    },

    async onStateless() {
      // Stateless workflow notifications are server-owned. A client cannot
      // turn this transport into an authority signal for its peers.
      return undefined;
    },

    async onDisconnect({ context, documentName }) {
      const connection = context?.reservationKey
        ? releaseReservation(context.reservationKey) as Connection<SidecarContext>
        : undefined;
      if (connection) {
        blocked.add(connection);
        awareness.release(connection, documentName);
      }
    },

    async afterUnloadDocument({ documentName }) {
      resources.releaseDocument(documentName);
    },
  });

  let drainPromise: Promise<void> | undefined;
  const beginDrain = () => {
    drainPromise ??= (async () => {
      health.beginDrain();
      const documents = new Map<string, { documentId: string; workspaceId: string }>();
      const captureRoom = (room: string) => {
        const identity = parseCollaborationRoomName(room);
        documents.set(
          `${identity.workspaceId}\0${identity.documentId}`,
          { documentId: identity.documentId, workspaceId: identity.workspaceId },
        );
      };
      for (const room of server.hocuspocus.documents.keys()) {
        captureRoom(room);
        closeRoomByName(room, "server_draining");
      }
      try {
        await durable.whenIdle();
        for (const room of server.hocuspocus.documents.keys()) {
          captureRoom(room);
          closeRoomByName(room, "server_draining");
        }
        await Promise.all([...documents.values()].map(async (identity) => {
          const scope = { workspaceId: identity.workspaceId };
          const snapshot = await options.persistence.load(scope, identity.documentId);
          if (!snapshot) throw new Error("collaboration document unavailable");
          try {
            await options.persistence.checkpoint(
              scope,
              identity.documentId,
              snapshot.generation,
            );
          } finally {
            snapshot.document.destroy();
          }
        }));
        server.hocuspocus.flushPendingStores();
        for (const document of server.hocuspocus.documents.values()) {
          for (const connection of document.getConnections()) {
            blocked.add(connection);
            connection.webSocket.close(1012, "server_draining");
          }
        }
      } catch {
        throw new CollaborationShutdownError("checkpoint_failed");
      }
    })();
    return drainPromise;
  };

  let destroyPromise: Promise<void> | undefined;
  return {
    get hocuspocus() {
      return server.hocuspocus;
    },
    get httpUrl() {
      return `http://${options.config.address}:${server.address.port}`;
    },
    get webSocketUrl() {
      return `ws://${options.config.address}:${server.address.port}`;
    },
    beginDrain,
    closeRoom: closeRoomByName,
    async destroy() {
      destroyPromise ??= (async () => {
        const outcome = await settleWithin(async () => {
          await beginDrain();
          try {
            await server.destroy();
          } catch {
            throw new CollaborationShutdownError("destroy_failed");
          }
        }, options.config.shutdownGraceMs, shutdownNow);
        if (outcome.status === "fulfilled") return;
        forceCloseServer(server);
        if (outcome.status === "rejected") {
          throw outcome.reason instanceof CollaborationShutdownError
            ? outcome.reason
            : new CollaborationShutdownError("destroy_failed");
        }
        throw new CollaborationShutdownError("grace_exceeded");
      })();
      return destroyPromise;
    },
    async listen() {
      if (health.isDraining) throw new CollaborationConnectionError("server_draining");
      await server.listen();
    },
    publishDurableUpdate(
      scope: WorkspaceScope,
      documentId: string,
      generation: number,
      update: Uint8Array,
    ) {
      const room = createCollaborationRoomName({
        documentId,
        generation,
        workspaceId: scope.workspaceId,
      });
      for (const loadedRoom of server.hocuspocus.documents.keys()) {
        let loadedIdentity: ReturnType<typeof parseCollaborationRoomName>;
        try {
          loadedIdentity = parseCollaborationRoomName(loadedRoom);
        } catch {
          continue;
        }
        if (
          loadedIdentity.workspaceId === scope.workspaceId
          && loadedIdentity.documentId === documentId
          && loadedIdentity.generation < generation
        ) {
          closeRoomByName(loadedRoom, "room_rotated");
        }
      }
      const document = server.hocuspocus.documents.get(room);
      if (!document) return;
      let growth: ReturnType<typeof resources.reserveDocumentGrowth>;
      try {
        growth = resources.reserveDocumentGrowth(room, update.byteLength);
      } catch {
        closeRoomByName(room, "resource_limit");
        throw new CollaborationConnectionError("update_rejected");
      }
      try {
        Y.applyUpdate(document, update, {
          context: { durable: true },
          source: "local",
        });
        growth.commit();
      } catch (error) {
        growth.rollback();
        closeRoomByName(room, "room_rotated");
        throw error;
      }
    },
    publishWorkflowChanged(
      scope: WorkspaceScope,
      documentId: string,
      generation: number,
    ) {
      publishWorkflowChangedByRoom(createCollaborationRoomName({
        documentId,
        generation,
        workspaceId: scope.workspaceId,
      }));
    },
  };
}

async function verifyCurrentContext(
  authority: ReturnType<typeof createCollaborationCapabilityAuthority>,
  authorization: CollaborationAuthorizationReader,
  token: string,
  documentName: string,
): Promise<VerifiedCollaborationContext> {
  const claims = await authority.verifyForRoom(token, documentName);
  const identity = parseCollaborationRoomName(documentName);
  const current = await authorization.readCapabilityAuthority(
    { workspaceId: identity.workspaceId },
    { documentId: identity.documentId, principalId: claims.principalId },
  );
  if (
    !current
    || current.authorizationEpoch !== claims.authorizationEpoch
    || current.generation !== identity.generation
  ) {
    throw new CollaborationConnectionError("authorization_revoked");
  }
  return contextFromClaims(claims, identity.generation);
}

function contextFromClaims(
  claims: CollaborationCapabilityClaims,
  generation: number,
): VerifiedCollaborationContext {
  const digest = createHash("sha256").update(claims.principalId).digest();
  const suffix = digest.subarray(0, 2).toString("hex").toUpperCase();
  return {
    authorizationEpoch: claims.authorizationEpoch,
    color: COLORS[digest[2]! % COLORS.length]!,
    displayName: `Participant ${suffix}`,
    documentId: claims.documentId,
    exp: claims.exp,
    generation,
    permission: claims.permission,
    principalId: claims.principalId,
    room: claims.room,
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
  };
}

function isAllowedUpgrade(
  { request }: onUpgradePayload,
  config: CollaborationServerConfig,
) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host || !config.allowedOrigins.includes(origin)) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return config.allowedHosts.includes(hostname);
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Socket) {
  if (socket.destroyed) return;
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

async function settleWithin(
  operation: () => Promise<unknown>,
  milliseconds: number,
  now: () => number,
): Promise<
  | { status: "fulfilled" }
  | { reason: unknown; status: "rejected" }
  | { status: "timeout" }
> {
  const startedAt = now();
  let running: Promise<unknown>;
  try {
    running = operation();
  } catch (reason) {
    return now() - startedAt >= milliseconds
      ? { status: "timeout" }
      : { reason, status: "rejected" };
  }
  const elapsed = Math.max(0, now() - startedAt);
  if (elapsed >= milliseconds) {
    void running.catch(() => undefined);
    return { status: "timeout" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running.then(
        () => now() - startedAt >= milliseconds
          ? ({ status: "timeout" as const })
          : ({ status: "fulfilled" as const }),
        (reason: unknown) => now() - startedAt >= milliseconds
          ? ({ status: "timeout" as const })
          : ({ reason, status: "rejected" as const }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "timeout" }),
          milliseconds - elapsed,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function forceCloseServer(server: Server<SidecarContext>) {
  try {
    server.hocuspocus.closeConnections();
    server.hocuspocus.flushPendingStores();
    server.httpServer.closeAllConnections?.();
  } catch {
    // The bounded shutdown error below remains the public failure category.
  }
  try {
    // Cleanup continues in the background, but can no longer extend the public
    // shutdown deadline beyond the configured grace period.
    void server.destroy().catch(() => undefined);
  } catch {
    // The public failure category was already selected by the grace outcome.
  }
}
