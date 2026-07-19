import * as decoding from "lib0/decoding";

import { COLLABORATION_LIMITS } from "./config";

export const AWARENESS_RATE_LIMIT = Object.freeze({ messages: 20, windowMs: 1_000 });

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
type PendingAwareness = { entries: ParsedAwarenessEntry[]; room: string };

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
  const activeClientByConnection = new WeakMap<object, number>();
  const activeClockByConnection = new WeakMap<object, number>();
  const ownerByRoom = new Map<string, Map<number, object>>();

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
        consumeRate(rates, connection, now());
        const entries = parseAwarenessPayload(payload);
        if (entries.length !== 1) throw rejected();
        const roomOwners = ownerByRoom.get(exactRoom) ?? new Map<number, object>();
        const activeClient = activeClientByConnection.get(connection);
        for (const entry of entries) {
          const owner = roomOwners.get(entry.clientId);
          if (owner && owner !== connection) throw rejected();
          if (activeClient !== undefined && activeClient !== entry.clientId) throw rejected();
          if (entry.state === null) {
            if (
              owner !== connection
              || entry.clock <= (activeClockByConnection.get(connection) ?? 0)
            ) {
              throw rejected();
            }
          } else {
            validateState(entry.state);
          }
        }
        pending.set(connection, { entries, room: exactRoom });
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
      if (!roomOwners) {
        roomOwners = new Map();
        ownerByRoom.set(room, roomOwners);
      }
      for (const entry of inbound.entries) {
        if (entry.state === null) {
          states.set(entry.clientId, null as unknown as AwarenessState);
          roomOwners.delete(entry.clientId);
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
        roomOwners.set(entry.clientId, connection);
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

    release(connection: object, exactRoom?: string) {
      pending.delete(connection);
      rates.delete(connection);
      const clientId = activeClientByConnection.get(connection);
      activeClientByConnection.delete(connection);
      activeClockByConnection.delete(connection);
      if (clientId === undefined) return;
      if (exactRoom) {
        const owners = ownerByRoom.get(exactRoom);
        if (owners?.get(clientId) === connection) owners.delete(clientId);
        if (owners?.size === 0) ownerByRoom.delete(exactRoom);
        return;
      }
      for (const [room, owners] of ownerByRoom) {
        if (owners.get(clientId) === connection) owners.delete(clientId);
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
  if (
    keys.length < 2
    || keys.some((key) => !["assoc", "item", "tname", "type"].includes(key))
    || (value.tname === undefined) === (value.type === undefined)
    || (value.assoc !== undefined && (
      !Number.isSafeInteger(value.assoc) || (value.assoc as number) < -1 || (value.assoc as number) > 1
    ))
  ) {
    throw rejected();
  }
  if (value.tname !== undefined && value.tname !== "body") throw rejected();
  if (value.type !== undefined) validateYjsId(value.type);
  if (value.item !== undefined) validateYjsId(value.item);
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
) {
  const current = rates.get(connection);
  if (!current || timestamp - current.windowStartedAt >= AWARENESS_RATE_LIMIT.windowMs) {
    rates.set(connection, { count: 1, windowStartedAt: timestamp });
    return;
  }
  if (current.count >= AWARENESS_RATE_LIMIT.messages) throw rejected();
  current.count += 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected() {
  return new AwarenessPolicyError();
}
