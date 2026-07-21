import type { Connection } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { writeSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";

import type {
  AppendAuthorizedClientUpdate,
  AppendCollaborationUpdate,
} from "../persistence";
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

  it("allows only a strict token refresh Auth frame to bypass the old context expiry", async () => {
    const valid = authFrame();
    expect(parseInboundCollaborationFrame(valid, room)).toEqual({ kind: "auth" });

    for (const invalid of [
      authFrame({ subtype: 1 }),
      authFrame({ omitProviderVersion: true }),
      authFrame({ omitToken: true }),
      authFrame({ trailing: true }),
    ]) {
      expect(() => parseInboundCollaborationFrame(invalid, room)).toThrowError(
        expect.objectContaining({ reason: "invalid_message" }),
      );
    }

    const fixture = hookFixture({ context: { ...context, exp: 1 } });
    await expect(fixture.hooks.before(
      fixture.connection,
      authFrame({ subtype: 2 }),
    )).rejects.toMatchObject({ reason: "invalid_message" });
    expect(fixture.authorization.readCapabilityAuthority).not.toHaveBeenCalled();
  });

  it("never appends a read-only provider frame", async () => {
    const fixture = hookFixture({ context: { ...context, permission: "read" } });

    await fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("blocked")));

    expect(fixture.authorizedAppendInputs).toEqual([]);
    expect(fixture.authorization.readCapabilityAuthority).toHaveBeenCalledOnce();
  });

  it("uses the atomic authorized client append without a separate authority read", async () => {
    const fixture = hookFixture();

    await fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("atomic")));

    expect(fixture.authorization.readCapabilityAuthority).not.toHaveBeenCalled();
    expect(fixture.authorizedAppendInputs).toEqual([
      expect.objectContaining({
        authorizationEpoch: context.authorizationEpoch,
        documentId: context.documentId,
        generation: context.generation,
        originKind: "client",
        principalId: context.principalId,
      }),
    ]);
  });

  it("rejects an update before authorization or append when its rate window is exhausted", async () => {
    const consumeUpdate = vi.fn(() => {
      throw new Error("resource details");
    });
    const fixture = hookFixture({ consumeUpdate });
    const update = createUpdate("limited");

    await expect(fixture.hooks.before(
      fixture.connection,
      updateFrame(0, update),
    )).rejects.toMatchObject({ reason: "update_rejected" });
    expect(consumeUpdate).toHaveBeenCalledWith(fixture.connection, update.byteLength);
    expect(fixture.authorizedAppendInputs).toEqual([]);
    expect(fixture.authorization.readCapabilityAuthority).not.toHaveBeenCalled();
  });

  it("rolls conservative document growth back on append failure and commits it on success", async () => {
    const rollback = vi.fn();
    const commit = vi.fn();
    const append = deferred<never>();
    const failed = hookFixture({
      append: () => append.promise,
      reserveDocumentGrowth: () => ({ commit, rollback }),
    });
    const handling = failed.hooks.before(
      failed.connection,
      updateFrame(0, createUpdate("failed growth")),
    );
    await eventually(() => expect(failed.authorizedAppendInputs).toHaveLength(1));
    append.reject(new Error("append failed"));
    await expect(handling).rejects.toMatchObject({ reason: "storage_unavailable" });
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    const succeeded = hookFixture({
      reserveDocumentGrowth: () => ({ commit, rollback }),
    });
    await succeeded.hooks.before(
      succeeded.connection,
      updateFrame(0, createUpdate("committed growth")),
    );
    expect(commit).toHaveBeenCalledOnce();
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
    await eventually(() => expect(fixture.authorizedAppendInputs).toHaveLength(1));
    const queued = fixture.hooks.before(fixture.connection, updateFrame(0, createUpdate("queued")));
    append.reject(new Error("database details"));

    await expect(first).rejects.toMatchObject({ reason: "storage_unavailable" });
    await expect(queued).rejects.toBeInstanceOf(CollaborationConnectionError);
    expect(fixture.authorizedAppendInputs).toHaveLength(1);
  });

  it("blocks token refresh and updates immediately after draining starts", async () => {
    const fixture = hookFixture();
    fixture.setDraining(true);

    await expect(fixture.hooks.before(
      fixture.connection,
      authFrame(),
    )).rejects.toMatchObject({ reason: "server_draining" });
    await expect(fixture.hooks.before(
      fixture.connection,
      updateFrame(0, createUpdate("late")),
    )).rejects.toMatchObject({ reason: "server_draining" });
    expect(fixture.authorizedAppendInputs).toEqual([]);
  });

  it("broadcasts a bounded workflow signal only after an invalidating update is durably applied", async () => {
    const onWorkflowChanged = vi.fn();
    const changed = hookFixture({ onWorkflowChanged, workflowChanged: true });

    await changed.hooks.before(
      changed.connection,
      updateFrame(0, createUpdate("invalidates approval")),
    );
    expect(onWorkflowChanged).not.toHaveBeenCalled();
    await changed.hooks.after(changed.connection);
    expect(onWorkflowChanged).toHaveBeenCalledWith(room);

    const unchanged = hookFixture({ onWorkflowChanged, workflowChanged: false });
    await unchanged.hooks.before(
      unchanged.connection,
      updateFrame(0, createUpdate("ordinary workflow-neutral update")),
    );
    await unchanged.hooks.after(unchanged.connection);
    expect(onWorkflowChanged).toHaveBeenCalledTimes(1);
  });

  it("does not fail an already applied update when best-effort workflow notification fails", async () => {
    const fixture = hookFixture({
      onWorkflowChanged: vi.fn(() => { throw new Error("notification transport failed"); }),
      workflowChanged: true,
    });

    await fixture.hooks.before(
      fixture.connection,
      updateFrame(0, createUpdate("durable first")),
    );

    await expect(fixture.hooks.after(fixture.connection)).resolves.toBeUndefined();
  });

  it("rechecks draining after an authority read and after an in-flight append", async () => {
    const authority = deferred<{ authorizationEpoch: number; generation: number }>();
    const readFixture = hookFixture({
      authority: () => authority.promise,
      context: { ...context, permission: "read" },
    });
    const read = readFixture.hooks.before(readFixture.connection, syncStepOneFrame());
    await eventually(() => {
      expect(readFixture.authorization.readCapabilityAuthority).toHaveBeenCalledOnce();
    });
    readFixture.setDraining(true);
    authority.resolve({ authorizationEpoch: 3, generation: 1 });
    await expect(read).rejects.toMatchObject({ reason: "server_draining" });

    const append = deferred<{
      checksum: string;
      documentId: string;
      generation: number;
      headSeq: number;
      seq: number;
    }>();
    const writeFixture = hookFixture({ append: () => append.promise as Promise<never> });
    const write = writeFixture.hooks.before(
      writeFixture.connection,
      updateFrame(0, createUpdate("in flight")),
    );
    await eventually(() => expect(writeFixture.authorizedAppendInputs).toHaveLength(1));
    writeFixture.setDraining(true);
    let idle = false;
    const waitingForIdle = writeFixture.hooks.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    append.resolve({
      checksum: "a".repeat(64),
      documentId: context.documentId,
      generation: 1,
      headSeq: 1,
      seq: 1,
    });
    await expect(write).rejects.toMatchObject({ reason: "server_draining" });
    expect(writeFixture.onDurableApplyInterrupted).toHaveBeenCalledWith(room);
    await waitingForIdle;
    expect(idle).toBe(true);
  });
});

function hookFixture(options: {
  append?: (input: AppendCollaborationUpdate) => Promise<never>;
  authority?: () => Promise<{ authorizationEpoch: number; generation: number }>;
  consumeUpdate?: (connection: object, bytes: number) => void;
  context?: VerifiedCollaborationContext;
  reserveDocumentGrowth?: (
    room: string,
    bytes: number,
  ) => { commit(): void; rollback(): void };
  onWorkflowChanged?: (room: string) => void | Promise<void>;
  workflowChanged?: boolean;
} = {}) {
  let draining = false;
  const authorizedAppendInputs: AppendAuthorizedClientUpdate[] = [];
  const refreshes = new WeakMap<object, Promise<VerifiedCollaborationContext>>();
  const connection = {
    context: options.context ?? context,
    document: { name: room },
    readOnly: options.context?.permission === "read",
  } as Connection<VerifiedCollaborationContext>;
  const authorization = {
    readCapabilityAuthority: vi.fn(
      options.authority ?? (async () => ({ authorizationEpoch: 3, generation: 1 })),
    ),
  };
  const onDurableApplyInterrupted = vi.fn();
  const hooks = createDurableUpdateHooks({
    authorization,
    blocked: new WeakSet(),
    consumeUpdate: options.consumeUpdate ?? vi.fn(),
    finishAwareness: vi.fn(),
    isDraining: () => draining,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    onDurableApplyInterrupted,
    onWorkflowChanged: options.onWorkflowChanged,
    persistence: {
      async appendAuthorizedClientUpdate(_scope, input) {
        authorizedAppendInputs.push(input);
        if (options.append) return options.append(input);
        return {
          checksum: "a".repeat(64),
          documentId: input.documentId,
          generation: input.generation,
          headSeq: 1,
          seq: 1,
          workflowChanged: options.workflowChanged ?? false,
        };
      },
    },
    refreshes,
    reserveDocumentGrowth: options.reserveDocumentGrowth ?? (() => ({
      commit() {},
      rollback() {},
    })),
    validateAwareness: vi.fn(),
  });
  return {
    authorization,
    authorizedAppendInputs,
    connection,
    hooks,
    onDurableApplyInterrupted,
    refreshes,
    setDraining(next: boolean) {
      draining = next;
    },
  };
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

function authFrame(options: {
  omitProviderVersion?: boolean;
  omitToken?: boolean;
  subtype?: number;
  trailing?: boolean;
} = {}) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, room);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint(encoder, options.subtype ?? 0);
  if (!options.omitToken) encoding.writeVarString(encoder, "refreshed-token");
  if (!options.omitProviderVersion) encoding.writeVarString(encoder, "4.4.0");
  if (options.trailing) encoding.writeVarUint(encoder, 1);
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
