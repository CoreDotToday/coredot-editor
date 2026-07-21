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

  it("accepts the exact serialized Yjs relative-position shape real editors send", () => {
    // JSON-serialized Y.RelativePosition values carry explicit nulls, e.g.
    // {"type":null,"tname":"body","item":{...},"assoc":0} inside content and
    // {"type":null,"tname":"body","item":null,"assoc":0} at the type end.
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const realCursor = {
      anchor: { assoc: 0, item: { client: 7, clock: 2 }, tname: "body", type: null },
      head: { assoc: 0, item: null, tname: "body", type: null },
    };

    expect(() => policy.validateFrame(connection, awarenessPayload(7, {
      cursor: realCursor,
      user: { color: "", displayName: "" },
    }))).not.toThrow();

    const state = { cursor: realCursor, user: { color: "", displayName: "" } };
    const states = new Map<number, Record<string, unknown>>([[7, state]]);
    policy.sanitizeStates(connection, context, states);
    expect(states.get(7)).toMatchObject({ cursor: realCursor });
  });

  it("still rejects a relative position that asserts both a root name and a type id", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const conflicted = {
      anchor: {
        assoc: 0,
        item: null,
        tname: "body",
        type: { client: 7, clock: 1 },
      },
      head: { assoc: 0, item: null, tname: "body", type: null },
    };

    expect(() => policy.validateFrame(connection, awarenessPayload(7, { cursor: conflicted })))
      .toThrow(AwarenessPolicyError);
  });

  it("rejects oversize payloads and drops a keystroke burst without closing the connection", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    expect(() => policy.validateFrame(
      connection,
      awarenessPayload(7, { user: { name: "x".repeat(4 * 1024) } }),
    ))
      .toThrow(AwarenessPolicyError);
    for (let index = 0; index < AWARENESS_RATE_LIMIT.messages; index += 1) {
      const state = { cursor: cursor(7, index) };
      policy.validateFrame(connection, awarenessPayload(7, state, index + 1));
      policy.sanitizeStates(connection, context, new Map([[7, state]]));
    }

    // Awareness is ephemeral: a fast typist or a reconnect flush of queued
    // frames may exceed the per-connection budget. Excess frames are dropped
    // rather than treated as a protocol violation that closes the session.
    expect(() => policy.validateFrame(
      connection,
      awarenessPayload(7, { cursor: cursor(7, 99) }, 99),
    )).not.toThrow();
    const droppedStates = new Map<number, Record<string, unknown>>([
      [7, { cursor: cursor(7, 99) }],
    ]);
    policy.sanitizeStates(connection, context, droppedStates);
    expect(droppedStates).toEqual(new Map());
  });

  it("ignores a duplicate own removal echo instead of closing the connection", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const state = { cursor: cursor(7, 1) };
    policy.validateFrame(connection, awarenessPayload(7, state, 3));
    policy.sanitizeStates(connection, context, new Map([[7, state]]));

    expect(() => policy.validateFrame(connection, awarenessPayload(7, null, 3))).not.toThrow();
    const echoedRemoval = new Map<number, Record<string, unknown>>([
      [7, { cursor: cursor(7, 1) }],
    ]);
    policy.sanitizeStates(connection, context, echoedRemoval);
    expect(echoedRemoval).toEqual(new Map());

    // A genuinely newer removal still applies.
    policy.validateFrame(connection, awarenessPayload(7, null, 4));
    const removal = new Map<number, Record<string, unknown>>([[7, {}]]);
    policy.sanitizeStates(connection, context, removal);
    expect(removal.get(7)).toBeNull();
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

    // A cached foreign state whose owner is unknown is dropped, not applied:
    // real providers flush cached peers on reconnect, so rejecting would kill
    // legitimate connections, while applying would re-stamp the state with
    // the sender's identity.
    policy.validateFrame(first, awarenessPayload(8, { cursor: cursor(8, 2) }));
    const ghostStates = new Map<number, Record<string, unknown>>([
      [8, { cursor: cursor(8, 2) }],
    ]);
    policy.sanitizeStates(first, context, ghostStates);
    expect(ghostStates).toEqual(new Map());
  });

  it("accepts a real reconnect flush containing its own state plus cached peer echoes", () => {
    const peer = {};
    const reconnecting = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const peerState = { cursor: cursor(7, 1) };
    policy.validateFrame(peer, awarenessPayload(7, peerState, 3));
    policy.sanitizeStates(peer, context, new Map([[7, peerState]]));
    const canonicalPeerState = structuredClone(peerState) as Record<string, unknown>;

    // HocuspocusProvider flushes every client it knows on (re)connect:
    // its own state plus exact echoes and stale echoes of cached peers.
    const flush = multiAwarenessPayload([
      { clientId: 9, clock: 2, state: { cursor: cursor(9, 1) } },
      { clientId: 7, clock: 3, state: canonicalPeerState },
    ]);
    expect(() => policy.validateFrame(reconnecting, flush)).not.toThrow();
    const states = new Map<number, Record<string, unknown>>([
      [9, { cursor: cursor(9, 1) }],
      [7, structuredClone(canonicalPeerState)],
    ]);
    policy.sanitizeStates(reconnecting, context, states);
    expect(states.has(9)).toBe(true);
    expect(states.has(7)).toBe(false);

    // A stale echo with an older clock is dropped rather than treated as a
    // foreign mutation.
    const staleEcho = multiAwarenessPayload([
      { clientId: 9, clock: 3, state: { cursor: cursor(9, 2) } },
      { clientId: 7, clock: 1, state: { cursor: cursor(7, 9) } },
    ]);
    expect(() => policy.validateFrame(reconnecting, staleEcho)).not.toThrow();
    const staleStates = new Map<number, Record<string, unknown>>([
      [9, { cursor: cursor(9, 2) }],
      [7, { cursor: cursor(7, 9) }],
    ]);
    policy.sanitizeStates(reconnecting, context, staleStates);
    expect(staleStates.has(9)).toBe(true);
    expect(staleStates.has(7)).toBe(false);
  });

  it("survives a same-client reconnect while the dead connection still owns the client id", () => {
    const oldConnection = {};
    const newConnection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });
    const originalState = { cursor: cursor(7, 1) };
    policy.validateFrame(oldConnection, awarenessPayload(7, originalState, 1));
    policy.sanitizeStates(oldConnection, context, new Map([[7, originalState]]));

    // A network drop leaves the old owner registered until the server detects
    // the dead socket. The same tab reconnects with the same Yjs clientID and
    // a newer clock; the update is dropped without being applied, but the
    // connection must not be killed.
    const reconnectState = { cursor: cursor(7, 5) };
    expect(() => policy.validateFrame(newConnection, awarenessPayload(7, reconnectState, 2)))
      .not.toThrow();
    const droppedStates = new Map<number, Record<string, unknown>>([
      [7, structuredClone(reconnectState) as Record<string, unknown>],
    ]);
    policy.sanitizeStates(newConnection, context, droppedStates);
    expect(droppedStates).toEqual(new Map());

    // After the dead connection is released, the reconnecting tab regains
    // ownership with its next update.
    policy.release(oldConnection);
    policy.validateFrame(newConnection, awarenessPayload(7, reconnectState, 3));
    const recoveredStates = new Map<number, Record<string, unknown>>([
      [7, structuredClone(reconnectState) as Record<string, unknown>],
    ]);
    policy.sanitizeStates(newConnection, context, recoveredStates);
    expect(recoveredStates.get(7)).toMatchObject({ cursor: reconnectState.cursor });
  });

  it("rejects an ambiguous first frame that claims two unregistered live clients", () => {
    const connection = {};
    const policy = createAwarenessPolicy({ now: () => 1_000 });

    expect(() => policy.validateFrame(connection, multiAwarenessPayload([
      { clientId: 11, clock: 1, state: { cursor: cursor(11, 1) } },
      { clientId: 12, clock: 1, state: { cursor: cursor(12, 1) } },
    ]))).toThrow(AwarenessPolicyError);
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
  return multiAwarenessPayload([{ clientId, clock, state }]);
}

function multiAwarenessPayload(
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

function cursor(client: number, clock: number) {
  return {
    anchor: { assoc: 0, item: { client, clock }, tname: "body" },
    head: { assoc: 0, item: { client, clock }, tname: "body" },
  };
}
