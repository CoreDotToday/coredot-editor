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

    // Token-sync frames legitimately contain a provider-version suffix and are
    // parsed by Hocuspocus after this hook. They must bypass the old context's
    // expiry check so a connection can refresh itself.
    if (outerType === 2) return { kind: "auth" };
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
  finishAwareness(connection: object): void;
  now?: () => Date;
  onRoomRotated?(room: string): ReturnTypeOrPromise<void>;
  persistence: Pick<CollaborationPersistence, "appendValidatedUpdate">;
  refreshes: WeakMap<object, Promise<VerifiedCollaborationContext>>;
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

  const rejectConnection = (connection: object, reason: CollaborationCloseReason): never => {
    options.blocked.add(connection);
    throw new CollaborationConnectionError(reason);
  };

  return {
    async before(connection: ConnectionLike, rawFrame: Uint8Array) {
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
      const context = connection.context;
      if (!context || context.room !== connection.document.name) {
        rejectConnection(connection, "authorization_revoked");
      }
      assertNotExpired(connection, context, now, rejectConnection);

      if (parsed.kind === "update" && context.permission === "write") {
        const release = await sequencer.acquire(context.room);
        try {
          if (options.blocked.has(connection)) {
            rejectConnection(connection, "authorization_revoked");
          }
          assertNotExpired(connection, context, now, rejectConnection);

          // This is the authorization linearization point for Task 6. There is
          // deliberately no unrelated await between this current epoch/status/
          // generation read and invoking the durable append.
          const current = await options.authorization.readCapabilityAuthority(
            { workspaceId: context.workspaceId },
            { documentId: context.documentId, principalId: context.principalId },
          );
          assertCurrentAuthority(connection, context, current, rejectConnection);
          const receipt = await options.persistence.appendValidatedUpdate(
            { workspaceId: context.workspaceId },
            {
              documentId: context.documentId,
              generation: context.generation,
              idempotencyKey: createProviderIdempotencyKey(context, parsed.payload),
              originKind: "client",
              principalId: context.principalId,
              requestId: `ws:${context.sessionId}`,
              sessionId: context.sessionId,
              update: parsed.payload,
            },
          );
          retainRelease(heldReleases, connection, release);
          if (receipt.generation !== context.generation) rotatedAfterApply.add(connection);
          return receipt;
        } catch (error) {
          release();
          if (error instanceof CollaborationConnectionError) throw error;
          rejectConnection(connection, mapPersistenceFailure(error));
        }
      }

      const current = await options.authorization.readCapabilityAuthority(
        { workspaceId: context.workspaceId },
        { documentId: context.documentId, principalId: context.principalId },
      );
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
  };
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
