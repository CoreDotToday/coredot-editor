import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createCollaborationSessionStore } from "./session-store";
import {
  CollaborationSessionError,
  createHocuspocusProviderAdapter,
  type CollaborationProviderFactory,
  type CollaborationProviderFactoryOptions,
} from "./hocuspocus-provider-adapter";

const ROOM = "collab:v1:workspace-a:document-a:g1";
const ROTATED_ROOM = "collab:v1:workspace-a:document-a:g2";
const CHECKSUM = "a".repeat(64);

describe("Hocuspocus provider adapter", () => {
  it("uses only the exact page room and waits for authentication plus sync before writing", async () => {
    const fixture = createFixture();

    await fixture.session.connect();

    expect(fixture.issueCapability).toHaveBeenCalledTimes(1);
    expect(fixture.providers).toHaveLength(1);
    expect(fixture.providers[0]?.options).toMatchObject({ room: ROOM, url: "ws://localhost:1234" });
    expect(fixture.providers[0]?.options.getToken()).toBe("signed-token-1");
    expect(fixture.session.document).toBe(fixture.document);
    expect(fixture.session.provider).toBe(fixture.providers[0]?.provider);
    expect(fixture.session.room).toBe(ROOM);

    fixture.providers[0]?.options.events.status("connecting");
    expect(fixture.store.getSnapshot().status).toBe("connecting");

    fixture.providers[0]?.options.events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "connecting",
      transportSynced: true,
      writable: false,
    });

    fixture.providers[0]?.options.events.authenticated("read-write");
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "synced", writable: true });
  });

  it("reports later transport attempts as reconnecting while retaining post-sync writes", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);

    events.status("disconnected");
    events.status("connecting");

    expect(fixture.store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: true,
      status: "reconnecting",
      writable: true,
    });
  });

  it("does not treat the transport sync handshake as a durable update acknowledgement", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);

    events.unsyncedChanges(1);
    events.outgoingUpdate(new Uint8Array([1, 2, 3]), "incremental");
    expect(fixture.store.getSnapshot().pendingLocalUpdateCount).toBe(1);
    await settleMicrotasks();
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      CHECKSUM,
    ]);

    events.synced(true);
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      CHECKSUM,
    ]);

    events.unsyncedChanges(0);
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      CHECKSUM,
    ]);
    await fixture.timers.findLast((timer) => timer.delay === 2_000)?.callback();
    expect(fixture.store.getSnapshot().status).toBe("storage_delayed");

    events.durableAcknowledged();
    expect(fixture.store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      status: "synced",
    });
  });

  it("shows storage delay only after the durable acknowledgement grace and clears it on SyncStatus", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);
    events.unsyncedChanges(1);
    events.outgoingUpdate(new Uint8Array([4]), "incremental");
    await settleMicrotasks();

    expect(fixture.store.getSnapshot().status).toBe("synced");
    const delayTimer = fixture.timers.findLast((timer) => timer.delay === 2_000);
    expect(delayTimer).toBeDefined();
    delayTimer?.callback();
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "storage_delayed",
      writable: true,
    });

    events.durableAcknowledged();
    events.unsyncedChanges(0);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "synced", writable: true });
  });

  it("uses the reconnect SyncStep2 acknowledgement as a durable barrier for retransmitted state", async () => {
    const firstChecksum = "1".repeat(64);
    const retransmissionChecksum = "2".repeat(64);
    const fixture = createFixture({
      checksums: [firstChecksum, retransmissionChecksum],
    });
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);

    events.outgoingUpdate(new Uint8Array([1]), "incremental");
    await settleMicrotasks();
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      firstChecksum,
    ]);

    events.status("disconnected");
    events.status("connecting");
    events.outgoingUpdate(new Uint8Array([1, 2]), "sync-step-2");
    events.synced(true);
    await settleMicrotasks();
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      firstChecksum,
      retransmissionChecksum,
    ]);

    // The pre-disconnect frame has no acknowledgement to consume. The server
    // persisted the reconnect state diff, so this one SyncStatus is a durable
    // barrier for both the original update and its retransmission.
    events.durableAcknowledged();
    expect(fixture.store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      status: "synced",
    });
  });

  it("refreshes an in-memory token before expiry without persisting or exposing it", async () => {
    const fixture = createFixture({
      capabilities: [
        capability("signed-token-1"),
        capability("signed-token-2"),
      ],
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");

    await fixture.session.connect();
    const refreshTimer = fixture.timers.findLast((timer) => timer.delay === 45_000);
    expect(refreshTimer).toBeDefined();
    await refreshTimer?.callback();

    expect(fixture.providers[0]?.refreshToken).toHaveBeenCalledTimes(1);
    expect(fixture.providers[0]?.options.getToken()).toBe("signed-token-2");
    expect(JSON.stringify(fixture.store.getSnapshot())).not.toContain("signed-token");
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("rejects a refreshed capability for another generation and tears down the stale provider", async () => {
    const fixture = createFixture({
      capabilities: [
        capability("signed-token-1"),
        { ...capability("signed-token-2"), room: ROTATED_ROOM },
      ],
    });
    await fixture.session.connect();

    await expect(fixture.session.refreshCapability()).rejects.toMatchObject({
      category: "capability_invalid",
    });

    expect(fixture.store.getSnapshot()).toMatchObject({ status: "fatal", writable: false });
    expect(fixture.providers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.providers).toHaveLength(1);
    expect(fixture.session.provider).toBeNull();
  });

  it.each([
    ["authorization_expired", "authorization_expired"],
    ["authorization_revoked", "authorization_expired"],
    ["server_draining", "reconnecting"],
    ["storage_unavailable", "storage_delayed"],
    ["invalid_message", "fatal"],
    ["update_rejected", "fatal"],
    ["resource_limit", "fatal"],
  ] as const)("maps close reason %s to %s", async (reason, expectedStatus) => {
    const refresh = deferred<ReturnType<typeof capability>>();
    const fixture = createFixture({
      capabilities: [capability("signed-token-1")],
      issueCapabilityFallback: () => refresh.promise,
    });
    await fixture.session.connect();
    fixture.providers[0]?.options.events.authenticated("read-write");
    fixture.providers[0]?.options.events.synced(true);

    fixture.providers[0]?.options.events.closed({ code: 4400, reason });

    expect(fixture.store.getSnapshot()).toMatchObject({
      status: expectedStatus,
      writable: expectedStatus === "reconnecting" || expectedStatus === "storage_delayed",
    });
  });

  it("maps readonly authentication and expired-token authentication failures without optimistic writes", async () => {
    const refresh = deferred<ReturnType<typeof capability>>();
    const fixture = createFixture({
      capabilities: [capability("signed-token-1")],
      issueCapabilityFallback: () => refresh.promise,
    });
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;

    events.authenticated("readonly");
    events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "read_only", writable: false });

    events.authenticationFailed("authorization_expired");
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "authorization_expired",
      writable: false,
    });
  });

  it("treats a draining-sidecar authentication failure as reconnectable without capability churn", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);

    events.authenticationFailed("server_draining");

    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "reconnecting",
      writable: true,
    });
    expect(fixture.issueCapability).toHaveBeenCalledTimes(1);
    expect(fixture.providers[0]?.destroy).not.toHaveBeenCalled();
  });

  it.each([
    { ...capability("signed-token"), expiresInSeconds: 61 },
    { ...capability("signed-token"), room: ROTATED_ROOM },
    { ...capability("signed-token"), token: "" },
  ])("fails closed before provider creation for an invalid capability", async (invalidCapability) => {
    const fixture = createFixture({ capabilities: [invalidCapability] });

    await expect(fixture.session.connect()).rejects.toEqual(
      new CollaborationSessionError("capability_invalid"),
    );

    expect(fixture.providers).toHaveLength(0);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "fatal", writable: false });
  });

  it("tears down provider and timers exactly once and ignores late callbacks", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const provider = fixture.providers[0]!;
    provider.options.events.authenticated("read-write");
    provider.options.events.synced(true);
    const beforeDestroy = fixture.store.getSnapshot();

    fixture.session.destroy();
    fixture.session.destroy();
    provider.options.events.closed({ code: 4400, reason: "invalid_message" });
    provider.options.events.outgoingUpdate(new Uint8Array([9]), "incremental");
    await settleMicrotasks();

    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.clearTimer).toHaveBeenCalled();
    expect(fixture.store.getSnapshot()).toBe(beforeDestroy);
    expect(fixture.session.provider).toBeNull();
    await expect(fixture.session.connect()).rejects.toMatchObject({ category: "destroyed" });
  });

  it("contains provider cleanup failures and still completes idempotent teardown", async () => {
    const fixture = createFixture({ destroyFailures: [new Error("cleanup internals")] });
    await fixture.session.connect();

    expect(() => fixture.session.destroy()).not.toThrow();
    expect(() => fixture.session.destroy()).not.toThrow();

    expect(fixture.providers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.session.provider).toBeNull();
  });

  it("disposes a failed transport attempt and can create a fresh provider on retry", async () => {
    const fixture = createFixture({
      connectFailures: [new Error("socket detail must stay internal")],
    });

    await expect(fixture.session.connect()).rejects.toEqual(
      new CollaborationSessionError("transport_unavailable"),
    );
    expect(fixture.providers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.session.provider).toBeNull();
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "reconnecting", writable: false });

    await expect(fixture.session.connect()).resolves.toBeUndefined();
    expect(fixture.providers).toHaveLength(2);
    expect(fixture.issueCapability).toHaveBeenCalledTimes(2);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "reconnecting", writable: false });
  });
});

function createFixture(options: {
  capabilities?: Array<{ expiresInSeconds: number; room: string; token: string }>;
  checksums?: string[];
  connectFailures?: unknown[];
  destroyFailures?: unknown[];
  issueCapabilityFallback?: () => Promise<{ expiresInSeconds: number; room: string; token: string }>;
} = {}) {
  const document = new Y.Doc();
  const store = createCollaborationSessionStore();
  const capabilities = [...(options.capabilities ?? [capability("signed-token-1")])];
  const issueCapability = vi.fn(async () => {
    const next = capabilities.shift();
    if (next) return next;
    if (options.issueCapabilityFallback) return options.issueCapabilityFallback();
    return capability("signed-token-next");
  });
  const providers: Array<ReturnType<typeof createFakeProvider>> = [];
  const connectFailures = [...(options.connectFailures ?? [])];
  const destroyFailures = [...(options.destroyFailures ?? [])];
  const providerFactory: CollaborationProviderFactory = (factoryOptions) => {
    const provider = createFakeProvider(
      factoryOptions,
      connectFailures.shift(),
      destroyFailures.shift(),
    );
    providers.push(provider);
    return provider;
  };
  const timers: Array<{
    callback: () => void | Promise<void>;
    delay: number;
    id: { cleared: boolean };
  }> = [];
  const setTimer = vi.fn((callback: () => void | Promise<void>, delay: number) => {
    const id = { cleared: false };
    timers.push({
      callback: () => id.cleared ? undefined : callback(),
      delay,
      id,
    });
    return id;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    if (handle && typeof handle === "object" && "cleared" in handle) {
      (handle as { cleared: boolean }).cleared = true;
    }
  });
  const checksums = [...(options.checksums ?? [CHECKSUM])];
  const session = createHocuspocusProviderAdapter({
    checksum: async () => checksums.shift() ?? CHECKSUM,
    document,
    issueCapability,
    providerFactory,
    room: ROOM,
    store,
    timers: { clear: clearTimer, set: setTimer },
    url: "ws://localhost:1234",
  });

  return {
    clearTimer,
    document,
    issueCapability,
    providers,
    session,
    store,
    timers,
  };
}

function createFakeProvider(
  options: CollaborationProviderFactoryOptions,
  connectFailure?: unknown,
  destroyFailure?: unknown,
) {
  const provider = { awareness: null } as never;
  return {
    connect: vi.fn(async () => {
      if (connectFailure) throw connectFailure;
    }),
    destroy: vi.fn(() => {
      if (destroyFailure) throw destroyFailure;
    }),
    options,
    provider,
    refreshToken: vi.fn(async () => undefined),
  };
}

function capability(token: string) {
  return { expiresInSeconds: 60, room: ROOM, token };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
