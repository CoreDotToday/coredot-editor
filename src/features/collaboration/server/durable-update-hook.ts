import { createHash } from "node:crypto";

import type { Connection } from "@hocuspocus/server";
import * as decoding from "lib0/decoding";
import {
  messageYjsSyncStep1,
  messageYjsSyncStep2,
  messageYjsUpdate,
} from "y-protocols/sync";

import type { WorkspaceScope } from "@/features/auth/request-context";

import {
  CollaborationPersistenceError,
  type CollaborationPersistence,
} from "../persistence";
import type { VerifiedCollaborationContext } from "./awareness-policy";

type ReturnTypeOrPromise<T> = T | Promise<T>;
type ConnectionLike = Connection<VerifiedCollaborationContext>;

type CurrentAuthority = {
  authorizationEpoch: number;
  generation: number;
};

type AuthorizationReader = {
  readCapabilityAuthority(
    scope: WorkspaceScope,
    input: { documentId: string; principalId: string },
  ): Promise<CurrentAuthority | null>;
};

type ParsedInboundFrame =
  | { kind: "auth" }
  | { kind: "awareness"; payload: Uint8Array }
  | { kind: "other" }
  | { kind: "update"; payload: Uint8Array; syncSubtype: 1 | 2 };

export type CollaborationCloseReason =
  | "authorization_expired"
  | "authorization_revoked"
  | "invalid_message"
  | "room_rotated"
  | "server_draining"
  | "storage_unavailable"
  | "update_rejected";

export class CollaborationConnectionError extends Error {
  override readonly name = "CollaborationConnectionError";
  readonly code = 4400;

  constructor(readonly reason: CollaborationCloseReason) {
    super("Collaboration connection was closed");
  }
}

export function parseInboundCollaborationFrame(
  rawFrame: Uint8Array,
  exactRoom: string,
): ParsedInboundFrame {
  try {
    const decoder = decoding.createDecoder(rawFrame);
    const rawAddress = decoding.readVarString(decoder);
    const separator = rawAddress.indexOf("\0");
    const documentName = separator < 0 ? rawAddress : rawAddress.slice(0, separator);
    if (documentName !== exactRoom) throw invalidMessage();
    const outerType = decoding.readVarUint(decoder);

    // Only the pinned client-to-server token refresh shape may bypass the old
    // context's expiry check. Hocuspocus parses the same fields after this hook.
    if (outerType === 2) {
      const authSubtype = decoding.readVarUint(decoder);
      const token = decoding.readVarString(decoder);
      const providerVersion = decoding.readVarString(decoder);
      if (
        authSubtype !== 0
        || Buffer.byteLength(token, "utf8") < 1
        || Buffer.byteLength(token, "utf8") > 16 * 1024
        || Buffer.byteLength(providerVersion, "utf8") < 1
        || Buffer.byteLength(providerVersion, "utf8") > 128
        || /[\u0000-\u001f\u007f-\u009f]/.test(providerVersion)
        || decoding.hasContent(decoder)
      ) {
        throw invalidMessage();
      }
      return { kind: "auth" };
    }
    if (outerType === 0 || outerType === 4) {
      const syncSubtype = decoding.readVarUint(decoder);
      const payload = decoding.readVarUint8Array(decoder);
      if (decoding.hasContent(decoder)) throw invalidMessage();
      if (syncSubtype === messageYjsSyncStep1) return { kind: "other" };
      if (syncSubtype === messageYjsSyncStep2 || syncSubtype === messageYjsUpdate) {
        return { kind: "update", payload, syncSubtype };
      }
      throw invalidMessage();
    }
    if (outerType === 1) {
      const payload = decoding.readVarUint8Array(decoder);
      if (decoding.hasContent(decoder)) throw invalidMessage();
      return { kind: "awareness", payload };
    }
    if (outerType === 3 || outerType === 7) {
      if (decoding.hasContent(decoder)) throw invalidMessage();
      return { kind: "other" };
    }
    if (outerType === 5) {
      decoding.readVarString(decoder);
      if (decoding.hasContent(decoder)) throw invalidMessage();
      return { kind: "other" };
    }
    throw invalidMessage();
  } catch (error) {
    if (error instanceof CollaborationConnectionError) throw error;
    throw invalidMessage();
  }
}

export function createDurableUpdateHooks(options: {
  authorization: AuthorizationReader;
  blocked: WeakSet<object>;
  consumeUpdate(connection: object, bytes: number): void;
  finishAwareness(connection: object): void;
  isDraining(): boolean;
  now?: () => Date;
  onDurableApplyInterrupted?(room: string): ReturnTypeOrPromise<void>;
  onRoomRotated?(room: string): ReturnTypeOrPromise<void>;
  persistence: Pick<CollaborationPersistence, "appendAuthorizedClientUpdate">;
  refreshes: WeakMap<object, Promise<VerifiedCollaborationContext>>;
  reserveDocumentGrowth(
    room: string,
    bytes: number,
  ): { commit(): void; rollback(): void };
  validateAwareness(
    connection: object,
    payload: Uint8Array,
    room: string,
  ): ReturnTypeOrPromise<void>;
}) {
  const now = options.now ?? (() => new Date());
  const sequencer = createRoomSequencer();
  const heldReleases = new WeakMap<object, Array<() => void>>();
  const rotatedAfterApply = new WeakSet<object>();
  const inFlightAppends = new Set<Promise<unknown>>();

  const rejectConnection = (connection: object, reason: CollaborationCloseReason): never => {
    options.blocked.add(connection);
    throw new CollaborationConnectionError(reason);
  };

  return {
    async before(connection: ConnectionLike, rawFrame: Uint8Array) {
      if (options.isDraining()) {
        rejectConnection(connection, "server_draining");
      }
      if (options.blocked.has(connection)) {
        throw new CollaborationConnectionError("authorization_revoked");
      }
      const parsed = parseInboundCollaborationFrame(rawFrame, connection.document.name);
      if (parsed.kind === "auth") return;

      const refresh = options.refreshes.get(connection);
      if (refresh) {
        try {
          await refresh;
        } catch {
          rejectConnection(connection, "authorization_revoked");
        }
      }
      assertAvailable(connection, options, rejectConnection);
      const context = connection.context;
      if (!context || context.room !== connection.document.name) {
        rejectConnection(connection, "authorization_revoked");
      }
      assertNotExpired(connection, context, now, rejectConnection);

      if (parsed.kind === "update") {
        try {
          options.consumeUpdate(connection, parsed.payload.byteLength);
        } catch {
          rejectConnection(connection, "update_rejected");
        }
      }

      if (parsed.kind === "update" && context.permission === "write") {
        const release = await sequencer.acquire(context.room);
        let growth: { commit(): void; rollback(): void } | undefined;
        try {
          assertAvailable(connection, options, rejectConnection);
          assertNotExpired(connection, context, now, rejectConnection);

          const reservedGrowth = reserveGrowthOrReject(
            connection,
            context.room,
            parsed.payload.byteLength,
            options.reserveDocumentGrowth,
            rejectConnection,
          );
          growth = reservedGrowth;

          const receipt = await trackInFlight(
            inFlightAppends,
            options.persistence.appendAuthorizedClientUpdate(
              { workspaceId: context.workspaceId },
              {
                authorizationEpoch: context.authorizationEpoch,
                documentId: context.documentId,
                generation: context.generation,
                idempotencyKey: createProviderIdempotencyKey(context, parsed.payload),
                originKind: "client",
                principalId: context.principalId,
                requestId: `ws:${context.sessionId}`,
                sessionId: context.sessionId,
                update: parsed.payload,
              },
            ),
          );
          reservedGrowth.commit();
          try {
            assertAvailable(connection, options, rejectConnection);
          } catch (error) {
            await Promise.resolve(options.onDurableApplyInterrupted?.(context.room))
              .catch(() => undefined);
            throw error;
          }
          retainRelease(heldReleases, connection, release);
          if (receipt.generation !== context.generation) rotatedAfterApply.add(connection);
          return receipt;
        } catch (error) {
          growth?.rollback();
          release();
          if (error instanceof CollaborationConnectionError) throw error;
          rejectConnection(connection, mapPersistenceFailure(error));
        }
      }

      const current = await options.authorization.readCapabilityAuthority(
        { workspaceId: context.workspaceId },
        { documentId: context.documentId, principalId: context.principalId },
      );
      assertAvailable(connection, options, rejectConnection);
      assertCurrentAuthority(connection, context, current, rejectConnection);
      if (parsed.kind === "awareness") {
        try {
          await options.validateAwareness(connection, parsed.payload, context.room);
        } catch {
          rejectConnection(connection, "invalid_message");
        }
      }
    },

    async after(connection: ConnectionLike) {
      options.finishAwareness(connection);
      shiftRelease(heldReleases, connection)?.();
      if (rotatedAfterApply.has(connection)) {
        rotatedAfterApply.delete(connection);
        options.blocked.add(connection);
        await options.onRoomRotated?.(connection.document.name);
      }
    },

    async whenIdle() {
      while (inFlightAppends.size > 0) {
        await Promise.allSettled([...inFlightAppends]);
      }
    },
  };
}

function reserveGrowthOrReject(
  connection: object,
  room: string,
  bytes: number,
  reserve: (
    room: string,
    bytes: number,
  ) => { commit(): void; rollback(): void },
  reject: (connection: object, reason: CollaborationCloseReason) => never,
) {
  try {
    return reserve(room, bytes);
  } catch {
    return reject(connection, "update_rejected");
  }
}

function assertAvailable(
  connection: object,
  options: { blocked: WeakSet<object>; isDraining(): boolean },
  reject: (connection: object, reason: CollaborationCloseReason) => never,
) {
  if (options.isDraining()) reject(connection, "server_draining");
  if (options.blocked.has(connection)) reject(connection, "authorization_revoked");
}

async function trackInFlight<T>(inFlight: Set<Promise<unknown>>, operation: Promise<T>) {
  inFlight.add(operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(operation);
  }
}

function assertNotExpired(
  connection: object,
  context: VerifiedCollaborationContext,
  now: () => Date,
  reject: (connection: object, reason: CollaborationCloseReason) => never,
) {
  if (context.exp <= Math.floor(now().getTime() / 1_000)) {
    reject(connection, "authorization_expired");
  }
}

function assertCurrentAuthority(
  connection: object,
  context: VerifiedCollaborationContext,
  current: CurrentAuthority | null,
  reject: (connection: object, reason: CollaborationCloseReason) => never,
) {
  if (!current || current.authorizationEpoch !== context.authorizationEpoch) {
    reject(connection, "authorization_revoked");
  }
  if (current.generation !== context.generation) reject(connection, "room_rotated");
}

function createProviderIdempotencyKey(
  context: VerifiedCollaborationContext,
  update: Uint8Array,
) {
  const digest = createHash("sha256")
    .update(context.room)
    .update("\0")
    .update(context.principalId)
    .update("\0")
    .update(context.sessionId)
    .update("\0")
    .update(update)
    .digest("hex");
  return `provider:${digest}`;
}

function mapPersistenceFailure(error: unknown): CollaborationCloseReason {
  if (!(error instanceof CollaborationPersistenceError)) return "storage_unavailable";
  if (error.category === "authorization_revoked") return "authorization_revoked";
  if (error.category === "stale_generation") return "room_rotated";
  if (
    error.category === "invalid_input"
    || error.category === "schema_mismatch"
    || error.category === "checksum_mismatch"
  ) {
    return "update_rejected";
  }
  return "storage_unavailable";
}

function retainRelease(
  releases: WeakMap<object, Array<() => void>>,
  connection: object,
  release: () => void,
) {
  const queue = releases.get(connection) ?? [];
  queue.push(release);
  releases.set(connection, queue);
}

function shiftRelease(
  releases: WeakMap<object, Array<() => void>>,
  connection: object,
) {
  const queue = releases.get(connection);
  const release = queue?.shift();
  if (queue?.length === 0) releases.delete(connection);
  return release;
}

function createRoomSequencer() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(room: string) {
      const previous = tails.get(room) ?? Promise.resolve();
      let releaseCurrent!: () => void;
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const tail = previous.then(() => current, () => current);
      tails.set(room, tail);
      await previous.catch(() => undefined);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseCurrent();
        if (tails.get(room) === tail) tails.delete(room);
      };
    },
  };
}

function invalidMessage() {
  return new CollaborationConnectionError("invalid_message");
}
