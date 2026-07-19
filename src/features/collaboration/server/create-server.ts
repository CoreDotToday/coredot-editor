import { createHash } from "node:crypto";
import type { Socket } from "node:net";

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

export function createCollaborationSidecar(options: {
  authorization: CollaborationAuthorizationReader;
  config: CollaborationServerConfig;
  now?: () => Date;
  persistence: CollaborationPersistence;
  readinessChecks?: CollaborationReadinessChecks;
}) {
  const now = options.now ?? (() => new Date());
  const authority = createCollaborationCapabilityAuthority({
    now,
    verificationKeyRing: options.config.verificationKeyRing,
  });
  const awareness = createAwarenessPolicy({ now: () => now().getTime() });
  const blocked = new WeakSet<object>();
  const refreshes = new WeakMap<object, Promise<SidecarContext>>();
  const connections = createConnectionRegistry();
  const health = createCollaborationHealthController({
    checks: options.readinessChecks ?? {
      database: async () => false,
      migration: async () => false,
      workers: async () => false,
    },
  });

  const closeRoomByName = (
    exactRoom: string,
    reason: "archived" | "revoked" | "room_rotated" | "schema_changed" | "server_draining",
  ) => {
    const document = server.hocuspocus.documents.get(exactRoom);
    if (!document) return;
    for (const connection of document.getConnections() as Array<Connection<SidecarContext>>) {
      blocked.add(connection);
      connection.close({ code: 4400, reason });
    }
  };
  const durable = createDurableUpdateHooks({
    authorization: options.authorization,
    blocked,
    finishAwareness: awareness.finish,
    now,
    onRoomRotated: (room) => closeRoomByName(room, "room_rotated"),
    persistence: options.persistence,
    refreshes,
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
        const verified = await verifyCurrentContext(
          authority,
          options.authorization,
          payload.token,
          payload.documentName,
        );
        const reservationKey = connections.reserve(
          payload.socketId,
          verified,
        );
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
          const verified = await verifyCurrentContext(
            authority,
            options.authorization,
            payload.token,
            payload.documentName,
          );
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
        if (!snapshot || snapshot.generation !== context.generation) {
          throw new CollaborationConnectionError("room_rotated");
        }
        try {
          return Y.encodeStateAsUpdate(snapshot.document);
        } finally {
          snapshot.document.destroy();
        }
      } catch (error) {
        connections.release(context.reservationKey);
        if (error instanceof CollaborationConnectionError) throw error;
        throw new CollaborationConnectionError("storage_unavailable");
      }
    },

    async connected({ connection, context }) {
      connections.attach(context.reservationKey, connection);
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

    async onDisconnect({ context, documentName }) {
      const connection = context?.reservationKey
        ? connections.release(context.reservationKey)
        : undefined;
      if (connection) {
        blocked.add(connection);
        awareness.release(connection, documentName);
      }
    },
  });

  let drainPromise: Promise<void> | undefined;
  const beginDrain = () => {
    drainPromise ??= (async () => {
      health.beginDrain();
      const rooms = [...server.hocuspocus.documents.keys()];
      for (const room of rooms) closeRoomByName(room, "server_draining");
      await Promise.allSettled(rooms.map(async (room) => {
        const identity = parseCollaborationRoomName(room);
        await options.persistence.checkpoint(
          { workspaceId: identity.workspaceId },
          identity.documentId,
          identity.generation,
        );
      }));
      server.hocuspocus.flushPendingStores();
      for (const document of server.hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) {
          blocked.add(connection);
          connection.webSocket.close(1012, "server_draining");
        }
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
        await beginDrain();
        const destroyed = server.destroy();
        const completed = await withDeadline(destroyed, options.config.shutdownGraceMs);
        if (!completed) {
          server.httpServer.closeAllConnections?.();
          await withDeadline(destroyed, 250);
        }
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
      const document = server.hocuspocus.documents.get(room);
      if (!document) return;
      Y.applyUpdate(document, update, {
        context: { durable: true },
        source: "local",
      });
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

function createConnectionRegistry() {
  const reservations = new Map<string, {
    connection?: Connection<SidecarContext>;
    principal: string;
    room: string;
  }>();
  const principalCounts = new Map<string, number>();
  const roomCounts = new Map<string, number>();
  return {
    reserve(
      socketId: string,
      context: VerifiedCollaborationContext,
    ) {
      const key = `${socketId}\0${context.room}`;
      if (reservations.has(key)) throw new CollaborationConnectionError("authorization_revoked");
      const principal = `${context.workspaceId}\0${context.principalId}`;
      const principalCount = principalCounts.get(principal) ?? 0;
      const roomCount = roomCounts.get(context.room) ?? 0;
      if (
        principalCount >= COLLABORATION_LIMITS.maxConnectionsPerPrincipal
        || roomCount >= COLLABORATION_LIMITS.maxConnectionsPerRoom
      ) {
        throw new CollaborationConnectionError("authorization_revoked");
      }
      reservations.set(key, { principal, room: context.room });
      principalCounts.set(principal, principalCount + 1);
      roomCounts.set(context.room, roomCount + 1);
      return key;
    },
    attach(key: string, connection: Connection<SidecarContext>) {
      const reservation = reservations.get(key);
      if (reservation) reservation.connection = connection;
    },
    release(key: string) {
      const reservation = reservations.get(key);
      if (!reservation) return;
      reservations.delete(key);
      decrement(principalCounts, reservation.principal);
      decrement(roomCounts, reservation.room);
      return reservation.connection;
    },
  };
}

function decrement(counts: Map<string, number>, key: string) {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
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

async function withDeadline(operation: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
