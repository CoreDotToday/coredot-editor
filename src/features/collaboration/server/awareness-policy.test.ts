import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";

import {
  AWARENESS_RATE_LIMIT,
  AWARENESS_TOTAL_RATE_LIMIT,
  AwarenessPolicyError,
  createAwarenessPolicy,
} from "./awareness-policy";

const context = {
  authorizationEpoch: 0,
  documentId: "document-a",
  displayName: "Participant 7A2C",
  exp: 1_800_000_000,
  generation: 1,
  permission: "write" as const,
  principalId: "principal-a",
  room: "collab:v1:workspace-a:document-a:g1",
  sessionId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "workspace-a",
  color: "#1D4ED8",
};

describe("server-owned Awareness policy", () => {
  it("replaces spoofable identity while preserving bounded cursor data", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    policy.validateFrame(connection, awarenessPayload(7, {
      cursor: cursor(7, 2),
      user: { color: "#ffffff", name: "Administrator", principalId: "spoof" },
    }));
    const existingState = {
      cursor: cursor(7, 2),
      user: { color: "#ffffff", name: "Administrator", principalId: "spoof" },
    };
    const states = new Map<number, Record<string, unknown>>([
      [7, existingState],
      [999, {}],
    ]);

    policy.sanitizeStates(connection, context, states);

    expect(states.get(7)).toEqual({
      cursor: cursor(7, 2),
      user: {
        color: context.color,
        displayName: context.displayName,
        principalId: context.principalId,
        sessionId: context.sessionId,
      },
    });
    expect(states.get(7)).toBe(existingState);
    expect(states.has(999)).toBe(false);
  });

  it.each([
    ["email", { user: { email: "private@example.test" } }],
    ["role", { role: "owner" }],
    ["token", { token: "capability" }],
    ["document content", { content: "document text" }],
    ["excess key", { status: "editing" }],
    ["invalid cursor shape", { cursor: { anchor: 2, head: 4 } }],
    ["long string", { cursor: { ...cursor(7, 1), label: "x".repeat(129) } }],
  ] as const)("rejects %s without retaining the private state", (_label, state) => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    expect(() => policy.validateFrame(connection, awarenessPayload(7, state)))
      .toThrow(AwarenessPolicyError);
  });

  it("rejects payloads over 4 KiB and a high-frequency sender", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    expect(() => policy.validateFrame(
      connection,
      awarenessPayload(7, { user: { name: "x".repeat(4 * 1024) } }),
    ))
      .toThrow(AwarenessPolicyError);
    for (let index = 0; index < AWARENESS_RATE_LIMIT.messages; index += 1) {
      const state = { cursor: cursor(7, index) };
      policy.validateFrame(connection, awarenessPayload(7, state));
      policy.sanitizeStates(connection, context, new Map([[7, state]]));
    }
    expect(() => policy.validateFrame(connection, awarenessPayload(7, { cursor: cursor(7, 99) })))
      .toThrow(AwarenessPolicyError);
  });

  it("drops exact canonical echoes without rate amplification and rejects foreign mutation", () => {
    const first = {};
    const second = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const firstState = { cursor: cursor(7, 1) };
    policy.validateFrame(first, awarenessPayload(7, firstState));
    policy.sanitizeStates(first, context, new Map([[7, firstState]]));

    const canonical = firstState as Record<string, unknown>;
    for (let index = 0; index < AWARENESS_RATE_LIMIT.messages + 5; index += 1) {
      policy.validateFrame(second, awarenessPayload(7, canonical));
      const echoedStates = new Map([[7, structuredClone(canonical)]]);
      policy.sanitizeStates(second, context, echoedStates);
      expect(echoedStates).toEqual(new Map());
    }

    expect(() => policy.validateFrame(
      second,
      awarenessPayload(7, { cursor: cursor(7, 3) }),
    )).toThrow(AwarenessPolicyError);

    expect(() => policy.validateFrame(first, awarenessPayload(8, { cursor: cursor(8, 2) })))
      .toThrow(AwarenessPolicyError);
  });

  it("treats an unknown removal tombstone as a no-op", () => {
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const connection = {};
    policy.validateFrame(connection, awarenessPayload(99, null, 2));
    const states = new Map([[99, null as unknown as Record<string, unknown>]]);
    policy.sanitizeStates(connection, context, states);
    expect(states).toEqual(new Map());
  });

  it("does not retain room owner maps during unknown tombstone churn", () => {
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    for (let index = 0; index < 100; index += 1) {
      const connection = {};
      const room = `${context.room}:unknown-${index}`;
      policy.validateFrame(connection, awarenessPayload(index + 1, null, 2), room);
      const states = new Map([
        [index + 1, null as unknown as Record<string, unknown>],
      ]);
      policy.sanitizeStates(connection, { ...context, room }, states);
      expect(states).toEqual(new Map());
    }

    expect(policy.trackedRoomCount()).toBe(0);
  });

  it("deletes the room owner map after the final explicit removal", () => {
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const connection = {};
    const state = { cursor: cursor(7, 1) };
    policy.validateFrame(connection, awarenessPayload(7, state), context.room);
    policy.sanitizeStates(connection, context, new Map([[7, state]]));
    expect(policy.trackedRoomCount()).toBe(1);

    policy.validateFrame(connection, awarenessPayload(7, null, 2), context.room);
    policy.sanitizeStates(
      connection,
      context,
      new Map([[7, null as unknown as Record<string, unknown>]]),
    );

    expect(policy.trackedRoomCount()).toBe(0);
  });

  it("deletes each room owner map when its final connection is released", () => {
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    for (let index = 0; index < 100; index += 1) {
      const connection = {};
      const clientId = index + 1;
      const room = `${context.room}:owner-${index}`;
      const state = { cursor: cursor(clientId, 1) };
      policy.validateFrame(connection, awarenessPayload(clientId, state), room);
      policy.sanitizeStates(connection, { ...context, room }, new Map([[clientId, state]]));
      expect(policy.trackedRoomCount()).toBe(1);

      policy.release(connection, room);
      expect(policy.trackedRoomCount()).toBe(0);
    }
  });

  it("applies a separate total-frame ceiling to rate-free canonical echoes", () => {
    const owner = {};
    const echoer = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const state = { cursor: cursor(7, 1) };
    policy.validateFrame(owner, awarenessPayload(7, state));
    policy.sanitizeStates(owner, context, new Map([[7, state]]));

    for (let index = 0; index < AWARENESS_TOTAL_RATE_LIMIT.messages; index += 1) {
      policy.validateFrame(echoer, awarenessPayload(7, state));
      policy.sanitizeStates(echoer, context, new Map([[7, structuredClone(state)]]));
    }
    expect(() => policy.validateFrame(echoer, awarenessPayload(7, state)))
      .toThrow(AwarenessPolicyError);
  });

  it("preserves an owned removal and rejects malformed or trailing payload bytes", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const state = { cursor: cursor(7, 1) };
    policy.validateFrame(connection, awarenessPayload(7, state));
    policy.sanitizeStates(connection, context, new Map([[7, state]]));

    policy.validateFrame(connection, awarenessPayload(7, null, 2));
    const scratchStates = new Map<number, Record<string, unknown>>([[999, {}]]);
    policy.sanitizeStates(connection, context, scratchStates);
    expect(scratchStates).toEqual(new Map([[7, null]]));

    expect(() => policy.validateFrame(connection, new Uint8Array([1])))
      .toThrow(AwarenessPolicyError);
    const clockZeroStates = new Map<number, Record<string, unknown>>([[999, {}]]);
    policy.validateFrame(
      connection,
      awarenessPayload(8, { cursor: cursor(8, 2) }, 0),
    );
    policy.sanitizeStates(connection, context, clockZeroStates);
    expect(clockZeroStates).toEqual(new Map());
    const valid = awarenessPayload(8, { cursor: cursor(8, 2) });
    expect(() => policy.validateFrame(connection, Uint8Array.from([...valid, 0])))
      .toThrow(AwarenessPolicyError);
  });
});

function awarenessPayload(clientId: number, state: unknown, clock = 1) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

function cursor(client: number, clock: number) {
  return {
    anchor: { assoc: 0, item: { client, clock }, tname: "body" },
    head: { assoc: 0, item: { client, clock }, tname: "body" },
  };
}
