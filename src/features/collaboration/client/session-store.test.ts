import { describe, expect, it, vi } from "vitest";

import { createCollaborationSessionStore } from "./session-store";

const firstChecksum = "a".repeat(64);
const secondChecksum = "b".repeat(64);

describe("collaboration session store", () => {
  it("requires authentication and the first transport sync before becoming writable", () => {
    const store = createCollaborationSessionStore();

    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: false,
      status: "connecting",
      transportSynced: false,
      writable: false,
    });

    store.markAuthenticated("read-write");
    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: false,
      permission: "write",
      status: "connecting",
      transportSynced: false,
      writable: false,
    });

    store.markTransportSynced();
    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: true,
      permission: "write",
      status: "synced",
      transportSynced: true,
      writable: true,
    });
  });

  it("keeps a transport-synced readonly capability non-writable", () => {
    const store = createCollaborationSessionStore();

    store.markAuthenticated("readonly");
    store.markTransportSynced();

    expect(store.getSnapshot()).toMatchObject({
      permission: "read",
      status: "read_only",
      transportSynced: true,
      writable: false,
    });
  });

  it("keeps an incompatible browser schema in read-only projection mode", () => {
    const store = createCollaborationSessionStore();

    store.markSchemaIncompatible();

    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: false,
      permission: "read",
      status: "read_only",
      writable: false,
    });
  });

  it("tracks local and awaiting-durable checksums as separate phases", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();

    store.recordLocalUpdate(firstChecksum);
    store.recordLocalUpdate(secondChecksum);
    expect(store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      pendingLocalChecksums: [firstChecksum, secondChecksum],
      status: "synced",
    });

    store.markAwaitingDurableAcknowledgement(firstChecksum);
    expect(store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [firstChecksum],
      pendingLocalChecksums: [secondChecksum],
    });

    store.markStorageDelayed();
    expect(store.getSnapshot()).toMatchObject({ status: "storage_delayed", writable: true });

    store.acknowledgeDurableUpdate(firstChecksum);
    expect(store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [],
      pendingLocalChecksums: [secondChecksum],
      status: "synced",
    });
  });

  it("publishes an unhashed local update synchronously for navigation guards", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();

    store.beginLocalUpdate();
    expect(store.getSnapshot()).toMatchObject({
      pendingLocalChecksums: [],
      pendingLocalUpdateCount: 1,
    });

    store.resolvePendingLocalUpdate(firstChecksum);
    expect(store.getSnapshot()).toMatchObject({
      pendingLocalChecksums: [firstChecksum],
      pendingLocalUpdateCount: 0,
    });
  });

  it("distinguishes offline work from an ordinary reconnect", () => {
    const store = createCollaborationSessionStore();

    store.markDisconnected();
    expect(store.getSnapshot()).toMatchObject({ status: "reconnecting", writable: false });

    store.recordLocalUpdate(firstChecksum);
    expect(store.getSnapshot()).toMatchObject({ status: "offline_pending", writable: false });

    store.beginConnecting({ reconnecting: true });
    expect(store.getSnapshot()).toMatchObject({
      pendingLocalChecksums: [firstChecksum],
      status: "offline_pending",
      transportSynced: false,
      writable: false,
    });
  });

  it("keeps a previously synced write session editable through a temporary interruption", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();

    store.markDisconnected();
    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: true,
      permission: "write",
      status: "reconnecting",
      transportSynced: false,
      writable: true,
    });

    store.recordLocalUpdate(firstChecksum);
    expect(store.getSnapshot()).toMatchObject({
      pendingLocalChecksums: [firstChecksum],
      status: "offline_pending",
      writable: true,
    });
  });

  it("revokes local write authority immediately while a capability is being refreshed", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();

    store.beginReauthenticating();

    expect(store.getSnapshot()).toMatchObject({
      hasCompletedInitialSync: true,
      permission: null,
      status: "reconnecting",
      transportSynced: false,
      writable: false,
    });

    store.markAuthenticated("read-write");
    expect(store.getSnapshot()).toMatchObject({
      permission: "write",
      status: "reconnecting",
      writable: false,
    });

    store.markTransportSynced();
    expect(store.getSnapshot()).toMatchObject({ status: "synced", writable: true });
  });

  it("prioritizes offline pending work over a prior storage-delay warning", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();
    store.recordLocalUpdate(firstChecksum);
    store.markAwaitingDurableAcknowledgement(firstChecksum);
    store.markStorageDelayed();

    store.markDisconnected();

    expect(store.getSnapshot()).toMatchObject({
      pendingDurableAcknowledgementChecksums: [firstChecksum],
      status: "offline_pending",
      writable: true,
    });
  });

  it("fails closed for expired authorization and fatal lifecycle failures", () => {
    const store = createCollaborationSessionStore();
    store.markAuthenticated("read-write");
    store.markTransportSynced();

    store.markAuthorizationExpired();
    expect(store.getSnapshot()).toMatchObject({
      status: "authorization_expired",
      writable: false,
    });

    store.beginConnecting({ reconnecting: true });
    expect(store.getSnapshot()).toMatchObject({ status: "reconnecting", writable: false });

    store.markFatal();
    expect(store.getSnapshot()).toMatchObject({ status: "fatal", writable: false });
    store.markAuthenticated("read-write");
    store.markTransportSynced();
    expect(store.getSnapshot()).toMatchObject({ status: "fatal", writable: false });
  });

  it("publishes immutable snapshots only when observable state changes", () => {
    const store = createCollaborationSessionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();

    store.beginConnecting();
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();

    store.markAuthenticated("read-write");
    expect(store.getSnapshot()).not.toBe(initial);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().pendingLocalChecksums)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.markTransportSynced();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed checksums without leaking them into snapshots", () => {
    const store = createCollaborationSessionStore();

    expect(() => store.recordLocalUpdate("token-like-secret")).toThrowError(
      "Invalid collaboration update checksum",
    );
    expect(store.getSnapshot().pendingLocalChecksums).toEqual([]);
  });
});
