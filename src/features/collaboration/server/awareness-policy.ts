import { isDeepStrictEqual } from "node:util";

import * as decoding from "lib0/decoding";

import { COLLABORATION_LIMITS } from "./config";

export const AWARENESS_RATE_LIMIT = Object.freeze({ messages: 20, windowMs: 1_000 });
export const AWARENESS_TOTAL_RATE_LIMIT = Object.freeze({ messages: 256, windowMs: 1_000 });

export type VerifiedCollaborationContext = {
  authorizationEpoch: number;
  color: string;
  displayName: string;
  documentId: string;
  exp: number;
  generation: number;
  permission: "read" | "write";
  principalId: string;
  room: string;
  sessionId: string;
  workspaceId: string;
};

type AwarenessState = Record<string, unknown>;
type ParsedAwarenessEntry = { clientId: number; clock: number; state: AwarenessState | null };
type AwarenessOwner = { clock: number; connection: object; state: AwarenessState };
type PendingAwareness = {
  entries: ParsedAwarenessEntry[];
  ignoredClientIds: Set<number>;
  room: string;
};

const MAX_STATE_KEYS = 2;
const MAX_STRING_CODE_UNITS = 128;
const ALLOWED_STATE_KEYS = new Set(["cursor", "user"]);
const FORBIDDEN_KEYS = /^(?:authorization|capability|content|document|email|metadata|role|title|token)$/i;

export class AwarenessPolicyError extends Error {
  override readonly name = "AwarenessPolicyError";
  readonly code = 4400;
  readonly reason = "awareness_rejected";

  constructor() {
    super("Awareness update was rejected");
  }
}

export function createAwarenessPolicy(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const pending = new WeakMap<object, PendingAwareness>();
  const rates = new WeakMap<object, { count: number; windowStartedAt: number }>();
  const totalRates = new WeakMap<object, { count: number; windowStartedAt: number }>();
  const activeClientByConnection = new WeakMap<object, number>();
  const activeClockByConnection = new WeakMap<object, number>();
  const ownerByRoom = new Map<string, Map<number, AwarenessOwner>>();

  return {
    validateFrame(connection: object, payload: Uint8Array, exactRoom = "__test__") {
      try {
        if (
          !(payload instanceof Uint8Array)
          || payload.byteLength < 1
          || payload.byteLength > COLLABORATION_LIMITS.awarenessBytes
        ) {
          throw rejected();
        }
        const entries = parseAwarenessPayload(payload);
        if (entries.length < 1) throw rejected();
        consumeRate(totalRates, connection, now(), AWARENESS_TOTAL_RATE_LIMIT);
        const roomOwners = ownerByRoom.get(exactRoom) ?? new Map<number, AwarenessOwner>();
        const activeClient = activeClientByConnection.get(connection);
        const ignoredClientIds = new Set<number>();
        // HocuspocusProvider flushes every client it knows on (re)connect, so
        // one frame may combine the connection's own state with cached peer
        // echoes. At most one entry per frame may claim a new live client.
        let liveCandidateClientId: number | undefined;
        for (const entry of entries) {
          const owner = roomOwners.get(entry.clientId);
          if (owner && owner.connection !== connection) {
            // A stale echo (older clock) and the exact canonical clock/state
            // are rate-free no-ops. A newer clock cannot be told apart from a
            // same-client reconnect racing its dead connection's cleanup, so
            // it is dropped without being applied; ownership recovers once
            // the dead connection is released. A mutation at the canonical
            // clock is a definite spoof attempt and remains a rejection.
            if (entry.clock < owner.clock) {
              ignoredClientIds.add(entry.clientId);
              continue;
            }
            if (
              entry.state !== null
              && entry.clock === owner.clock
              && isDeepStrictEqual(entry.state, owner.state)
            ) {
              ignoredClientIds.add(entry.clientId);
              continue;
            }
            if (entry.clock > owner.clock) {
              consumeRate(rates, connection, now());
              ignoredClientIds.add(entry.clientId);
              continue;
            }
            consumeRate(rates, connection, now());
            throw rejected();
          }
          if (!owner && entry.state === null) {
            // A provider may echo a removal after the owner was already
            // released. The tombstone cannot remove any live state.
            ignoredClientIds.add(entry.clientId);
            continue;
          }
          if (!owner && activeClient !== undefined && activeClient !== entry.clientId) {
            // A cached foreign state whose owner already left cannot be
            // applied under this connection's identity; drop it instead of
            // killing a legitimate reconnect flush.
            ignoredClientIds.add(entry.clientId);
            continue;
          }
          if (activeClient !== undefined && activeClient !== entry.clientId) throw rejected();
          if (activeClient === undefined && entry.clientId !== liveCandidateClientId) {
            if (liveCandidateClientId !== undefined) throw rejected();
            liveCandidateClientId = entry.clientId;
          }
          if (entry.state === null) {
            if (entry.clock <= (activeClockByConnection.get(connection) ?? 0)) {
              // A duplicate or stale removal echo cannot remove newer state
              // and must not close an otherwise healthy connection.
              ignoredClientIds.add(entry.clientId);
              continue;
            }
            if (owner?.connection !== connection) throw rejected();
          } else {
            validateState(entry.state);
          }
          if (!tryConsumeRate(rates, connection, now())) {
            // Awareness is ephemeral. A fast typist or a reconnect flush of
            // queued frames may exceed the per-connection budget; drop the
            // whole frame instead of closing the session.
            for (const dropped of entries) ignoredClientIds.add(dropped.clientId);
            break;
          }
        }
        pending.set(connection, { entries, ignoredClientIds, room: exactRoom });
      } catch (error) {
        if (error instanceof AwarenessPolicyError) throw error;
        throw rejected();
      }
    },

    sanitizeStates(
      connection: object,
      context: VerifiedCollaborationContext,
      states: Map<number, AwarenessState>,
    ) {
      const inbound = pending.get(connection);
      if (!inbound || inbound.room !== context.room && inbound.room !== "__test__") {
        throw rejected();
      }
      const inboundIds = new Set(inbound.entries.map((entry) => entry.clientId));
      for (const clientId of states.keys()) {
        if (!inboundIds.has(clientId)) states.delete(clientId);
      }
      const room = inbound.room === "__test__" ? inbound.room : context.room;
      let roomOwners = ownerByRoom.get(room);
      for (const entry of inbound.entries) {
        if (inbound.ignoredClientIds.has(entry.clientId)) {
          states.delete(entry.clientId);
          continue;
        }
        if (entry.state === null) {
          states.set(entry.clientId, null as unknown as AwarenessState);
          roomOwners?.delete(entry.clientId);
          if (roomOwners?.size === 0) {
            ownerByRoom.delete(room);
            roomOwners = undefined;
          }
          activeClientByConnection.delete(connection);
          activeClockByConnection.delete(connection);
          continue;
        }
        const existing = states.get(entry.clientId);
        if (!existing) {
          // y-awareness treats an unknown non-null clock=0 state as a protocol
          // no-op, so the scratch Awareness intentionally has no meta/state for
          // it. Never manufacture a state without matching scratch metadata.
          if (entry.clock === 0) continue;
          throw rejected();
        }
        const sanitized: AwarenessState = {
          user: {
            color: context.color,
            displayName: context.displayName,
            principalId: context.principalId,
            sessionId: context.sessionId,
          },
        };
        if (entry.state.cursor !== undefined) {
          sanitized.cursor = structuredClone(entry.state.cursor);
        }
        for (const key of Object.keys(existing)) delete existing[key];
        Object.assign(existing, sanitized);
        if (!roomOwners) {
          roomOwners = new Map();
          ownerByRoom.set(room, roomOwners);
        }
        roomOwners.set(entry.clientId, {
          clock: entry.clock,
          connection,
          state: structuredClone(sanitized),
        });
        activeClientByConnection.set(connection, entry.clientId);
        activeClockByConnection.set(
          connection,
          Math.max(entry.clock, activeClockByConnection.get(connection) ?? 0),
        );
      }
      pending.delete(connection);
    },

    finish(connection: object) {
      pending.delete(connection);
    },

    trackedRoomCount() {
      return ownerByRoom.size;
    },

    release(connection: object, exactRoom?: string) {
      pending.delete(connection);
      rates.delete(connection);
      totalRates.delete(connection);
      const clientId = activeClientByConnection.get(connection);
      activeClientByConnection.delete(connection);
      activeClockByConnection.delete(connection);
      if (clientId === undefined) return;
      if (exactRoom) {
        const owners = ownerByRoom.get(exactRoom);
        if (owners?.get(clientId)?.connection === connection) owners.delete(clientId);
        if (owners?.size === 0) ownerByRoom.delete(exactRoom);
        return;
      }
      for (const [room, owners] of ownerByRoom) {
        if (owners.get(clientId)?.connection === connection) owners.delete(clientId);
        if (owners.size === 0) ownerByRoom.delete(room);
      }
    },
  };
}

function parseAwarenessPayload(payload: Uint8Array): ParsedAwarenessEntry[] {
  const decoder = decoding.createDecoder(payload);
  const count = decoding.readVarUint(decoder);
  if (count > 8) throw rejected();
  const entries: ParsedAwarenessEntry[] = [];
  const clientIds = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const encodedState = decoding.readVarString(decoder);
    if (
      !Number.isSafeInteger(clientId)
      || !Number.isSafeInteger(clock)
      || clock < 0
      || clientIds.has(clientId)
    ) {
      throw rejected();
    }
    clientIds.add(clientId);
    const state = JSON.parse(encodedState) as unknown;
    if (state !== null && (!isRecord(state) || Array.isArray(state))) throw rejected();
    entries.push({ clientId, clock, state: state as AwarenessState | null });
  }
  if (decoding.hasContent(decoder)) throw rejected();
  return entries;
}

function validateState(state: AwarenessState) {
  const keys = Object.keys(state);
  if (keys.length > MAX_STATE_KEYS || keys.some((key) => !ALLOWED_STATE_KEYS.has(key))) {
    throw rejected();
  }
  if (state.cursor !== undefined && state.cursor !== null) validateCursor(state.cursor);
  if (state.user !== undefined) validateUntrustedUser(state.user);
}

function validateCursor(value: unknown) {
  if (!isRecord(value) || Object.keys(value).toSorted().join(",") !== "anchor,head") {
    throw rejected();
  }
  validateRelativePosition(value.anchor);
  validateRelativePosition(value.head);
}

function validateRelativePosition(value: unknown) {
  if (!isRecord(value)) throw rejected();
  const keys = Object.keys(value);
  // Serialized Y.RelativePosition values carry explicit nulls for absent
  // parts, so null is normalized to "absent" before shape checks.
  const tname = value.tname ?? undefined;
  const type = value.type ?? undefined;
  const item = value.item ?? undefined;
  const assoc = value.assoc ?? undefined;
  if (
    keys.length < 2
    || keys.some((key) => !["assoc", "item", "tname", "type"].includes(key))
    || (tname === undefined) === (type === undefined)
    || (assoc !== undefined && (
      !Number.isSafeInteger(assoc) || (assoc as number) < -1 || (assoc as number) > 1
    ))
  ) {
    throw rejected();
  }
  if (tname !== undefined && tname !== "body") throw rejected();
  if (type !== undefined) validateYjsId(type);
  if (item !== undefined) validateYjsId(item);
}

function validateYjsId(value: unknown) {
  if (
    !isRecord(value)
    || Object.keys(value).toSorted().join(",") !== "client,clock"
    || !Number.isSafeInteger(value.client)
    || !Number.isSafeInteger(value.clock)
    || (value.client as number) < 0
    || (value.clock as number) < 0
  ) {
    throw rejected();
  }
}

function validateUntrustedUser(value: unknown) {
  if (!isRecord(value)) throw rejected();
  const entries = Object.entries(value);
  if (entries.length > 8) throw rejected();
  for (const [key, nested] of entries) {
    if (
      key.length < 1
      || key.length > 64
      || FORBIDDEN_KEYS.test(key)
      || (typeof nested !== "string" && nested !== null)
      || (typeof nested === "string" && (
        nested.length > MAX_STRING_CODE_UNITS
        || /[\u0000-\u001f\u007f-\u009f]/.test(nested)
      ))
    ) {
      throw rejected();
    }
  }
}

function consumeRate(
  rates: WeakMap<object, { count: number; windowStartedAt: number }>,
  connection: object,
  timestamp: number,
  limit: { messages: number; windowMs: number } = AWARENESS_RATE_LIMIT,
) {
  if (!tryConsumeRate(rates, connection, timestamp, limit)) throw rejected();
}

function tryConsumeRate(
  rates: WeakMap<object, { count: number; windowStartedAt: number }>,
  connection: object,
  timestamp: number,
  limit: { messages: number; windowMs: number } = AWARENESS_RATE_LIMIT,
) {
  const current = rates.get(connection);
  if (!current || timestamp - current.windowStartedAt >= limit.windowMs) {
    rates.set(connection, { count: 1, windowStartedAt: timestamp });
    return true;
  }
  if (current.count >= limit.messages) return false;
  current.count += 1;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected() {
  return new AwarenessPolicyError();
}
