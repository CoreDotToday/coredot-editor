import { COLLABORATION_LIMITS } from "./config";

export type CollaborationResourceLimitCategory =
  | "connection_limit"
  | "document_limit"
  | "update_limit";

export class CollaborationResourceLimitError extends Error {
  override readonly name = "CollaborationResourceLimitError";

  constructor(readonly category: CollaborationResourceLimitCategory) {
    super("Collaboration resource limit exceeded");
  }
}

type ResourceLimitKey =
  | "maxConnectionsPerPrincipal"
  | "maxConnectionsPerRoom"
  | "maxConnectionsPerWorkspace"
  | "maxLoadedDocumentBytes"
  | "maxLoadedDocuments"
  | "updateBytesPerWindow"
  | "updateMessagesPerWindow"
  | "updateWindowMs";
type ResourceLimits = { [Key in ResourceLimitKey]: number };

type ConnectionIdentity = {
  principalId: string;
  room: string;
  workspaceId: string;
};

export function createCollaborationResourceRegistry(
  limits: ResourceLimits = COLLABORATION_LIMITS,
  now: () => number = Date.now,
) {
  const reservations = new Map<string, {
    connection?: object;
    principal: string;
    room: string;
    workspace: string;
  }>();
  const principalCounts = new Map<string, number>();
  const roomCounts = new Map<string, number>();
  const workspaceCounts = new Map<string, number>();
  const updateWindows = new WeakMap<object, {
    bytes: number;
    messages: number;
    startedAt: number;
  }>();
  const loadedDocuments = new Map<string, { bytes: number; incarnation: number }>();
  let loadedDocumentBytes = 0;
  let nextDocumentIncarnation = 1;

  return {
    attachConnection(key: string, connection: object) {
      const reservation = reservations.get(key);
      if (reservation) reservation.connection = connection;
    },

    consumeUpdate(connection: object, bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw limit("update_limit");
      const currentTime = now();
      const previous = updateWindows.get(connection);
      const window = !previous || currentTime - previous.startedAt >= limits.updateWindowMs
        ? { bytes: 0, messages: 0, startedAt: currentTime }
        : previous;
      if (
        window.messages + 1 > limits.updateMessagesPerWindow
        || window.bytes + bytes > limits.updateBytesPerWindow
      ) {
        throw limit("update_limit");
      }
      window.messages += 1;
      window.bytes += bytes;
      updateWindows.set(connection, window);
    },

    releaseConnection(key: string) {
      const reservation = reservations.get(key);
      if (!reservation) return;
      reservations.delete(key);
      decrement(principalCounts, reservation.principal);
      decrement(roomCounts, reservation.room);
      decrement(workspaceCounts, reservation.workspace);
      return reservation.connection;
    },

    releaseDocument(room: string) {
      const loaded = loadedDocuments.get(room);
      if (!loaded) return;
      loadedDocuments.delete(room);
      loadedDocumentBytes -= loaded.bytes;
    },

    reserveConnection(socketId: string, context: ConnectionIdentity) {
      const key = `${socketId}\0${context.room}`;
      if (reservations.has(key)) throw limit("connection_limit");
      const principal = `${context.workspaceId}\0${context.principalId}`;
      const principalCount = principalCounts.get(principal) ?? 0;
      const roomCount = roomCounts.get(context.room) ?? 0;
      const workspaceCount = workspaceCounts.get(context.workspaceId) ?? 0;
      if (
        principalCount >= limits.maxConnectionsPerPrincipal
        || roomCount >= limits.maxConnectionsPerRoom
        || workspaceCount >= limits.maxConnectionsPerWorkspace
      ) {
        throw limit("connection_limit");
      }
      reservations.set(key, {
        principal,
        room: context.room,
        workspace: context.workspaceId,
      });
      principalCounts.set(principal, principalCount + 1);
      roomCounts.set(context.room, roomCount + 1);
      workspaceCounts.set(context.workspaceId, workspaceCount + 1);
      return key;
    },

    reserveDocument(room: string, bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw limit("document_limit");
      if (loadedDocuments.has(room)) return;
      if (
        loadedDocuments.size >= limits.maxLoadedDocuments
        || loadedDocumentBytes + bytes > limits.maxLoadedDocumentBytes
      ) {
        throw limit("document_limit");
      }
      loadedDocuments.set(room, { bytes, incarnation: nextDocumentIncarnation++ });
      loadedDocumentBytes += bytes;
    },

    // Yjs updates are not proportional to the encoded resident document, so
    // raw update bytes are deliberately counted as a conservative upper bound.
    // An unload/reload replaces that bound with the exact snapshot size again.
    reserveDocumentGrowth(room: string, bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw limit("document_limit");
      const current = loadedDocuments.get(room);
      if (!current || loadedDocumentBytes + bytes > limits.maxLoadedDocumentBytes) {
        throw limit("document_limit");
      }
      const incarnation = current.incarnation;
      current.bytes += bytes;
      loadedDocumentBytes += bytes;
      let settled = false;
      return {
        commit() {
          settled = true;
        },
        rollback() {
          if (settled) return;
          settled = true;
          const latest = loadedDocuments.get(room);
          if (!latest || latest.incarnation !== incarnation) return;
          latest.bytes = Math.max(0, latest.bytes - bytes);
          loadedDocumentBytes = Math.max(0, loadedDocumentBytes - bytes);
        },
      };
    },
  };
}

function decrement(counts: Map<string, number>, key: string) {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

function limit(category: CollaborationResourceLimitCategory) {
  return new CollaborationResourceLimitError(category);
}
