import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createCollaborationSessionStore } from "./session-store";
import {
  CollaborationSessionError,
  createHocuspocusProviderHandle,
  createHocuspocusProviderAdapter,
  type CollaborationProviderFactory,
  type CollaborationProviderFactoryOptions,
} from "./hocuspocus-provider-adapter";

const ROOM = "collab:v1:workspace-a:document-a:g1";
const ROTATED_ROOM = "collab:v1:workspace-a:document-a:g2";
const CHECKSUM = "a".repeat(64);

describe("Hocuspocus provider adapter", () => {
  it("returns an exact generation and state-vector barrier only after durable local flush", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);
    fixture.document.getText("test").insert(0, "local");
    events.unsyncedChanges(1);
    events.outgoingUpdate(new Uint8Array([1]), "incremental");
    await settleMicrotasks();

    let settled = false;
    const barrier = fixture.session.flushPendingUpdates({ timeoutMs: 1_000 }).then((value) => {
      settled = true;
      return value;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);

    events.durableAcknowledged();
    events.unsyncedChanges(0);
    await expect(barrier).resolves.toEqual({
      generation: 1,
      stateVector: Y.encodeStateVector(fixture.document),
    });
  });

  it("fails a snapshot barrier for readonly, fatal, destroyed, or timed-out sessions", async () => {
    const readonly = createFixture();
    await readonly.session.connect();
    readonly.providers[0]!.options.events.authenticated("readonly");
    readonly.providers[0]!.options.events.synced(true);
    await expect(readonly.session.flushPendingUpdates()).rejects.toEqual(
      new CollaborationSessionError("not_writable"),
    );

    const fatal = createFixture();
    await fatal.session.connect();
    fatal.providers[0]!.options.events.authenticationFailed("invalid");
    await expect(fatal.session.flushPendingUpdates()).rejects.toEqual(
      new CollaborationSessionError("flush_unavailable"),
    );

    const destroyed = createFixture();
    destroyed.session.destroy();
    await expect(destroyed.session.flushPendingUpdates()).rejects.toEqual(
      new CollaborationSessionError("destroyed"),
    );

    const pending = createFixture();
    await pending.session.connect();
    pending.providers[0]!.options.events.authenticated("read-write");
    pending.providers[0]!.options.events.synced(true);
    pending.providers[0]!.options.events.unsyncedChanges(1);
    const timedOut = pending.session.flushPendingUpdates({ timeoutMs: 1 });
    await pending.timers.findLast((timer) => timer.delay === 1)?.callback();
    await expect(timedOut).rejects.toEqual(new CollaborationSessionError("flush_timeout"));
  });

  it("cancels a pending barrier and fences stale unsynced counts across reconnect", async () => {
    const fixture = createFixture();
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);
    events.unsyncedChanges(1);

    const controller = new AbortController();
    const aborted = fixture.session.flushPendingUpdates({ signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toEqual(new CollaborationSessionError("flush_aborted"));

    events.status("disconnected");
    events.status("connecting");
    let settled = false;
    const reconnected = fixture.session.flushPendingUpdates().then((value) => {
      settled = true;
      return value;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);
    events.synced(true);
    await expect(reconnected).resolves.toMatchObject({ generation: 1 });
  });

  it("delivers workflow-changed notifications only while the active session subscription exists", async () => {
    const fixture = createFixture();
    const listener = vi.fn();
    const unsubscribe = fixture.session.subscribeWorkflowChanged(listener);
    await fixture.session.connect();

    fixture.providers[0]?.options.events.workflowChanged();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    fixture.providers[0]?.options.events.workflowChanged();
    fixture.session.destroy();
    fixture.providers[0]?.options.events.workflowChanged();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("accepts only the exact bounded workflow-changed stateless payload", () => {
    const fixture = createRealProviderHandleFixture();
    const onStateless = fixture.handle.provider.configuration.onStateless;

    onStateless({ payload: JSON.stringify({ type: "workflow_changed", v: 1 }) });
    for (const payload of [
      "",
      "not-json",
      JSON.stringify({ type: "workflow_changed", v: 2 }),
      JSON.stringify({ type: "workflow_changed", v: 1, readiness: "approved" }),
      JSON.stringify({ type: "other", v: 1 }),
      JSON.stringify({ type: "workflow_changed", v: 1, padding: "x".repeat(512) }),
    ]) {
      onStateless({ payload });
    }

    expect(fixture.events.workflowChanged).toHaveBeenCalledOnce();
    fixture.handle.destroy();
  });

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

  it("separates the reconnect state barrier from new transport updates", async () => {
    const firstChecksum = "1".repeat(64);
    const secondChecksum = "2".repeat(64);
    const fixture = createFixture({
      checksums: [firstChecksum, secondChecksum],
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
    events.outgoingUpdate(new Uint8Array([2]), "incremental");
    events.synced(true);
    await settleMicrotasks();
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      firstChecksum,
      secondChecksum,
    ]);

    // Hocuspocus 4.4 writes the handshake SyncStep2 directly to its websocket,
    // bypassing onOutgoingMessage. Its first SyncStatus acknowledges only the
    // reconnect state barrier, not a later incremental frame.
    events.durableAcknowledged();
    expect(fixture.store.getSnapshot().pendingDurableAcknowledgementChecksums).toEqual([
      secondChecksum,
    ]);

    events.durableAcknowledged();
    expect(fixture.store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      status: "synced",
    });
  });

  it("refreshes by reconnecting with the in-memory token and waits for fresh auth plus sync", async () => {
    const fixture = createFixture({
      capabilities: [
        capability("signed-token-1"),
        capability("signed-token-2"),
      ],
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");

    await fixture.session.connect();
    const provider = fixture.providers[0]!;
    provider.options.events.authenticated("read-write");
    provider.options.events.synced(true);
    const refreshTimer = fixture.timers.findLast((timer) => timer.delay === 45_000);
    expect(refreshTimer).toBeDefined();
    const refreshing = refreshTimer?.callback();

    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: null,
      status: "reconnecting",
      transportSynced: false,
      writable: false,
    });
    await refreshing;

    expect(provider.reauthenticate).toHaveBeenCalledTimes(1);
    expect(provider.options.getToken()).toBe("signed-token-2");
    expect(fixture.store.getSnapshot().writable).toBe(false);
    provider.options.events.authenticated("read-write");
    expect(fixture.store.getSnapshot().writable).toBe(false);
    provider.options.events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "synced", writable: true });
    expect(JSON.stringify(fixture.store.getSnapshot())).not.toContain("signed-token");
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("applies a write-to-read downgrade only after reconnect authentication and sync", async () => {
    const fixture = createFixture({
      capabilities: [capability("signed-token-1"), capability("signed-token-read")],
    });
    await fixture.session.connect();
    const provider = fixture.providers[0]!;
    provider.options.events.authenticated("read-write");
    provider.options.events.synced(true);

    await fixture.session.refreshCapability();
    expect(provider.reauthenticate).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSnapshot()).toMatchObject({ permission: null, writable: false });

    provider.options.events.authenticated("readonly");
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: "read",
      status: "reconnecting",
      writable: false,
    });
    provider.options.events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: "read",
      status: "read_only",
      writable: false,
    });
  });

  it("ignores stale old-transport sync until the refreshed transport authenticates and syncs", async () => {
    const nextCapability = deferred<ReturnType<typeof capability>>();
    const fixture = createFixture({
      capabilities: [capability("signed-token-1")],
      issueCapabilityFallback: () => nextCapability.promise,
    });
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);

    const refreshing = fixture.session.refreshCapability();
    expect(fixture.providers[0]?.options.getToken()).toBe("");
    events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: null,
      transportSynced: false,
      writable: false,
    });

    nextCapability.resolve(capability("signed-token-2"));
    await refreshing;
    events.authenticated("read-write");
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: "write",
      transportSynced: false,
      writable: false,
    });
    events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "synced", writable: true });
  });

  it("opens the fresh authority barrier when refresh starts from a disconnected transport", async () => {
    const fixture = createFixture({
      capabilities: [capability("signed-token-1"), capability("signed-token-2")],
    });
    await fixture.session.connect();
    const events = fixture.providers[0]!.options.events;
    events.authenticated("read-write");
    events.synced(true);
    events.status("disconnected");

    await fixture.session.refreshCapability();
    events.authenticated("readonly");
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: "read",
      transportSynced: false,
      writable: false,
    });
    events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({ status: "read_only", writable: false });
  });

  it("preserves pending updates until the reconnect SyncStep2 durable barrier", async () => {
    const firstChecksum = "1".repeat(64);
    const fixture = createFixture({
      capabilities: [capability("signed-token-1"), capability("signed-token-2")],
      checksums: [firstChecksum],
    });
    await fixture.session.connect();
    const provider = fixture.providers[0]!;
    const events = provider.options.events;
    events.authenticated("read-write");
    events.synced(true);
    events.outgoingUpdate(new Uint8Array([1]), "incremental");
    await settleMicrotasks();

    await fixture.session.refreshCapability();
    expect(fixture.store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [firstChecksum],
      writable: false,
    });

    events.durableAcknowledged();
    events.authenticated("read-write");
    events.synced(true);
    expect(fixture.store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      status: "synced",
      writable: true,
    });
  });

  it("keeps a failed refresh non-writable and does not reuse the old authority", async () => {
    const fixture = createFixture({
      capabilities: [capability("signed-token-1")],
      issueCapabilityFallback: async () => {
        throw new Error("issuer details must stay internal");
      },
    });
    await fixture.session.connect();
    const provider = fixture.providers[0]!;
    provider.options.events.authenticated("read-write");
    provider.options.events.synced(true);

    const refreshing = fixture.session.refreshCapability();
    expect(fixture.store.getSnapshot().writable).toBe(false);
    await expect(refreshing).rejects.toEqual(
      new CollaborationSessionError("capability_unavailable"),
    );
    expect(provider.reauthenticate).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSnapshot()).toMatchObject({
      permission: null,
      status: "authorization_expired",
      writable: false,
    });
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
    ["authorization_expired", "reconnecting"],
    ["authorization_revoked", "reconnecting"],
    ["server_draining", "reconnecting"],
    ["storage_unavailable", "reconnecting"],
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
      writable: expectedStatus === "reconnecting" && reason === "server_draining",
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
      status: "reconnecting",
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

describe("Hocuspocus transport reauthentication", () => {
  it("quiesces an already disconnected transport before and after fast token preparation", async () => {
    const fixture = createRealProviderHandleFixture();
    const order: string[] = [];

    await fixture.handle.reauthenticate(
      async () => { order.push("prepare"); },
      () => { order.push("reset"); },
    );

    expect(fixture.disconnect).toHaveBeenCalledTimes(2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(order).toEqual(["prepare", "reset"]);
    fixture.handle.destroy();
  });

  it("waits for a connected transport to become disconnected without leaking its status listener", async () => {
    const fixture = createRealProviderHandleFixture();
    fixture.websocket.status = "connected" as never;
    const baselineStatusListeners = fixture.statusListenerCount();
    fixture.disconnect.mockImplementation(() => {
      queueMicrotask(() => fixture.emitStatus("disconnected"));
    });

    await fixture.handle.reauthenticate(async () => undefined, vi.fn());

    expect(fixture.statusListenerCount()).toBe(baselineStatusListeners);
    expect(fixture.connect).toHaveBeenCalledOnce();
    fixture.handle.destroy();
  });

  it("rejects and cleans the first disconnect wait when destroyed", async () => {
    const fixture = createRealProviderHandleFixture();
    fixture.websocket.status = "connected" as never;
    fixture.disconnect.mockImplementation(() => undefined);
    const baselineStatusListeners = fixture.statusListenerCount();
    const refreshing = fixture.handle.reauthenticate(async () => undefined, vi.fn());
    void refreshing.catch(() => undefined);
    await settleMicrotasks();
    expect(fixture.statusListenerCount()).toBe(baselineStatusListeners + 1);

    fixture.handle.destroy();

    await expect(refreshing).rejects.toEqual(new CollaborationSessionError("destroyed"));
    expect(fixture.off).toHaveBeenCalledWith("status", expect.any(Function));
  });

  it("rejects without reset or connect when destroyed during token preparation", async () => {
    const fixture = createRealProviderHandleFixture();
    const preparation = deferred<void>();
    const reset = vi.fn();
    const refreshing = fixture.handle.reauthenticate(() => preparation.promise, reset);
    void refreshing.catch(() => undefined);
    await settleMicrotasks();

    fixture.handle.destroy();
    preparation.resolve();

    await expect(refreshing).rejects.toEqual(new CollaborationSessionError("destroyed"));
    expect(reset).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects and cleans the second disconnect wait when destroyed", async () => {
    const fixture = createRealProviderHandleFixture();
    const reset = vi.fn();
    fixture.disconnect.mockImplementation(() => undefined);
    const baselineStatusListeners = fixture.statusListenerCount();
    const refreshing = fixture.handle.reauthenticate(async () => {
      fixture.websocket.status = "connected" as never;
    }, reset);
    void refreshing.catch(() => undefined);
    await vi.waitFor(() => {
      expect(fixture.statusListenerCount()).toBe(baselineStatusListeners + 1);
    });

    fixture.handle.destroy();

    await expect(refreshing).rejects.toEqual(new CollaborationSessionError("destroyed"));
    expect(fixture.off).toHaveBeenCalledWith("status", expect.any(Function));
    expect(reset).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("quiesces again and preserves an issuance rejection without reset or connect", async () => {
    const fixture = createRealProviderHandleFixture();
    const issuerFailure = new Error("issuer unavailable");
    const reset = vi.fn();

    await expect(fixture.handle.reauthenticate(
      async () => { throw issuerFailure; },
      reset,
    )).rejects.toBe(issuerFailure);

    expect(fixture.disconnect).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
    fixture.handle.destroy();
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

function createRealProviderHandleFixture() {
  const events: CollaborationProviderFactoryOptions["events"] = {
    authenticated: vi.fn(),
    authenticationFailed: vi.fn(),
    closed: vi.fn(),
    durableAcknowledged: vi.fn(),
    outgoingUpdate: vi.fn(),
    status: vi.fn(),
    synced: vi.fn(),
    unsyncedChanges: vi.fn(),
    workflowChanged: vi.fn(),
  };
  const handle = createHocuspocusProviderHandle({
    document: new Y.Doc(),
    events,
    getToken: () => "signed-token",
    room: ROOM,
    url: "ws://localhost:1234",
  });
  const websocket = handle.provider.configuration.websocketProvider;
  const disconnect = vi.spyOn(websocket, "disconnect");
  const connect = vi.spyOn(websocket, "connect").mockResolvedValue(undefined);
  const off = vi.spyOn(websocket, "off");
  const emitStatus = (status: "connected" | "connecting" | "disconnected") => {
    websocket.status = status as never;
    for (const callback of [...(websocket.callbacks.status ?? [])]) {
      callback({ status });
    }
  };
  return {
    connect,
    disconnect,
    emitStatus,
    events,
    handle,
    off,
    statusListenerCount: () => websocket.callbacks.status?.length ?? 0,
    websocket,
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
    reauthenticate: vi.fn(async (
      prepareToken: () => Promise<void>,
      onTransportReset: () => void,
    ) => {
      options.events.status("disconnected");
      await prepareToken();
      options.events.status("disconnected");
      onTransportReset();
      options.events.status("connecting");
    }),
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
