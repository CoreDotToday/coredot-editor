import type { Connection } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { writeSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";

import type { AppendCollaborationUpdate } from "../persistence";
import {
  CollaborationConnectionError,
  createDurableUpdateHooks,
  parseInboundCollaborationFrame,
} from "./durable-update-hook";
import type { VerifiedCollaborationContext } from "./awareness-policy";

const room = "collab:v1:workspace-a:document-a:g1";
const context: VerifiedCollaborationContext = {
  authorizationEpoch: 3,
  color: "#1D4ED8",
  displayName: "Participant 1234",
  documentId: "document-a",
  exp: 1_800_000_060,
  generation: 1,
  permission: "write",
  principalId: "principal-a",
  room,
  sessionId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "workspace-a",
};

describe("Hocuspocus raw frame durability hook", () => {
  it("extracts Update and SyncStep2 payloads from Sync and SyncReply but skips SyncStep1", () => {
    const update = createUpdate("one");

    expect(parseInboundCollaborationFrame(updateFrame(0, update), room))
      .toMatchObject({ kind: "update", payload: update, syncSubtype: 2 });
    expect(parseInboundCollaborationFrame(updateFrame(4, update), room))
      .toMatchObject({ kind: "update", payload: update, syncSubtype: 2 });
    expect(parseInboundCollaborationFrame(syncStepTwoFrame(0, update), room))
      .toMatchObject({ kind: "update", payload: update, syncSubtype: 1 });
    expect(parseInboundCollaborationFrame(syncStepOneFrame(), room)).toEqual({ kind: "other" });
  });

  it("rejects wrong-room, malformed, unknown-subtype, and trailing frames with one stable reason", () => {
    const update = createUpdate("one");
    const valid = updateFrame(0, update);
    const wrongRoom = updateFrame(0, update, `${room}-tampered`);
    const unknownSubtype = syncFrame(0, 9, update);

    for (const frame of [
      new Uint8Array([1]),
      wrongRoom,
      unknownSubtype,
      Uint8Array.from([...valid, 0]),
    ]) {
      expect(() => parseInboundCollaborationFrame(frame, room)).toThrowError(
        expect.objectContaining({ reason: "invalid_message" }),
      );
    }
  });

  it("never appends a read-only provider frame", async () => {
    const fixture = hookFixture({ context: { ...context, permission: "read" } });

    await fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("blocked")));

    expect(fixture.appendInputs).toEqual([]);
    expect(fixture.authorization.readCapabilityAuthority).toHaveBeenCalledOnce();
  });

  it("awaits a token refresh barrier before authorizing the next non-Auth frame", async () => {
    const expired = { ...context, exp: 1_799_999_999 };
    const fixture = hookFixture({ context: expired });
    const refresh = deferred<VerifiedCollaborationContext>();
    fixture.refreshes.set(
      fixture.connection,
      refresh.promise.then((next) => {
        fixture.connection.context = next;
        return next;
      }),
    );

    const handling = fixture.hooks.before(fixture.connection, syncStepOneFrame());
    await Promise.resolve();
    expect(fixture.authorization.readCapabilityAuthority).not.toHaveBeenCalled();

    refresh.resolve(context);
    await handling;
    expect(fixture.authorization.readCapabilityAuthority).toHaveBeenCalledOnce();
  });

  it("blocks every queued frame after the first durable failure and appends only once", async () => {
    const append = deferred<never>();
    const fixture = hookFixture({ append: () => append.promise });

    const first = fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("first")));
    await eventually(() => expect(fixture.appendInputs).toHaveLength(1));
    const queued = fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("queued")));
    append.reject(new Error("database details"));

    await expect(first).rejects.toMatchObject({ reason: "storage_unavailable" });
    await expect(queued).rejects.toBeInstanceOf(CollaborationConnectionError);
    expect(fixture.appendInputs).toHaveLength(1);
  });
});

function hookFixture(options: {
  append?: (input: AppendCollaborationUpdate) => Promise<never>;
  context?: VerifiedCollaborationContext;
} = {}) {
  const appendInputs: AppendCollaborationUpdate[] = [];
  const refreshes = new WeakMap<object, Promise<VerifiedCollaborationContext>>();
  const connection = {
    context: options.context ?? context,
    document: { name: room },
    readOnly: options.context?.permission === "read",
  } as Connection<VerifiedCollaborationContext>;
  const authorization = {
    readCapabilityAuthority: vi.fn(async () => ({ authorizationEpoch: 3, generation: 1 })),
  };
  const hooks = createDurableUpdateHooks({
    authorization,
    blocked: new WeakSet(),
    finishAwareness: vi.fn(),
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    persistence: {
      async appendValidatedUpdate(_scope, input) {
        appendInputs.push(input);
        if (options.append) return options.append(input);
        return {
          checksum: "a".repeat(64),
          documentId: input.documentId,
          generation: input.generation,
          headSeq: 1,
          seq: 1,
        };
      },
    },
    refreshes,
    validateAwareness: vi.fn(),
  });
  return { appendInputs, authorization, connection, hooks, refreshes };
}

function createUpdate(value: string) {
  const document = new Y.Doc();
  document.getText("test").insert(0, value);
  return Y.encodeStateAsUpdate(document);
}

function updateFrame(outerType: number, update: Uint8Array, address = room) {
  return syncFrame(outerType, 2, update, address);
}

function syncStepTwoFrame(outerType: number, update: Uint8Array) {
  return syncFrame(outerType, 1, update);
}

function syncFrame(outerType: number, subtype: number, payload: Uint8Array, address = room) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, address);
  encoding.writeVarUint(encoder, outerType);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

function syncStepOneFrame() {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, room);
  encoding.writeVarUint(encoder, 0);
  const document = new Y.Doc();
  writeSyncStep1(encoder, document);
  return encoding.toUint8Array(encoder);
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

async function eventually(assertion: () => void, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw failure;
}
