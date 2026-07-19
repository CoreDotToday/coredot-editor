import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import * as decoding from "lib0/decoding";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { parseCollaborationRoomName } from "../room-name";
import type { CollaborationSessionStore } from "./session-store";

export type CollaborationCapability = {
  expiresInSeconds: number;
  room: string;
  token: string;
};

export type CollaborationProviderFactoryOptions = {
  document: Y.Doc;
  events: {
    authenticated(scope: "read-write" | "readonly"): void;
    authenticationFailed(reason: string): void;
    closed(event: { code: number; reason: string }): void;
    durableAcknowledged(): void;
    outgoingUpdate(update: Uint8Array, kind: "incremental" | "sync-step-2"): void;
    status(status: "connected" | "connecting" | "disconnected"): void;
    synced(state: boolean): void;
    unsyncedChanges(number: number): void;
  };
  getToken(): string;
  room: string;
  url: string;
};

export type CollaborationHocuspocusProvider = HocuspocusProvider & {
  readonly awareness: Awareness;
};

export type CollaborationProviderHandle = {
  connect(): Promise<void>;
  destroy(): void;
  provider: CollaborationHocuspocusProvider;
  reauthenticate(
    prepareToken: () => Promise<void>,
    onTransportReset: () => void,
  ): Promise<void>;
};

export type CollaborationProviderFactory = (
  options: CollaborationProviderFactoryOptions,
) => CollaborationProviderHandle;

type CollaborationSessionErrorCategory =
  | "capability_invalid"
  | "capability_unavailable"
  | "destroyed"
  | "transport_unavailable";

export class CollaborationSessionError extends Error {
  override readonly name = "CollaborationSessionError";

  constructor(readonly category: CollaborationSessionErrorCategory) {
    super("Collaboration session is unavailable");
  }
}

export type CollaborationSession = {
  connect(): Promise<void>;
  readonly document: Y.Doc;
  destroy(): void;
  readonly provider: CollaborationHocuspocusProvider | null;
  refreshCapability(): Promise<void>;
  readonly room: string;
  readonly store: CollaborationSessionStore;
};

type TimerApi = {
  clear(handle: unknown): void;
  set(callback: () => void | Promise<void>, delay: number): unknown;
};

type PendingUpdate = {
  acknowledged: boolean;
  checksum?: string;
};

const MAX_CAPABILITY_LIFETIME_SECONDS = 60;
const MAX_TOKEN_BYTES = 16 * 1024;
const REFRESH_LEAD_TIME_MS = 15_000;
const STORAGE_DELAY_MS = 2_000;

export function createHocuspocusProviderAdapter(options: {
  checksum?: (update: Uint8Array) => Promise<string>;
  document: Y.Doc;
  issueCapability: () => Promise<CollaborationCapability>;
  providerFactory?: CollaborationProviderFactory;
  room: string;
  store: CollaborationSessionStore;
  timers?: TimerApi;
  url: string;
}): CollaborationSession {
  assertExpectedRoom(options.room);
  assertWebSocketUrl(options.url);

  const checksum = options.checksum ?? sha256;
  const providerFactory = options.providerFactory ?? createHocuspocusProviderHandle;
  const timers = options.timers ?? browserTimers;
  const pendingUpdates: PendingUpdate[] = [];
  const reconnectBarrierUpdates: PendingUpdate[] = [];
  let capability: CollaborationCapability | undefined;
  let connectPromise: Promise<void> | undefined;
  let destroyed = false;
  let hasAttemptedConnect = false;
  let awaitingTransportBarrier = false;
  let lifecycleId = 0;
  let providerHandle: CollaborationProviderHandle | undefined;
  let acceptingReauthenticationEvents = false;
  let reauthenticationAuthenticated = false;
  let reauthenticationPending = false;
  let reauthenticationSawDisconnect = false;
  let reauthenticationSynced = false;
  let refreshPromise: Promise<void> | undefined;
  let refreshTimer: unknown;
  let storageDelayTimer: unknown;

  const clearRefreshTimer = () => {
    if (refreshTimer === undefined) return;
    timers.clear(refreshTimer);
    refreshTimer = undefined;
  };
  const clearStorageDelayTimer = () => {
    if (storageDelayTimer === undefined) return;
    timers.clear(storageDelayTimer);
    storageDelayTimer = undefined;
  };
  const isCurrent = (id: number) => !destroyed && lifecycleId === id && !!providerHandle;

  const teardownProvider = () => {
    const current = providerHandle;
    providerHandle = undefined;
    lifecycleId += 1;
    clearRefreshTimer();
    clearStorageDelayTimer();
    try {
      current?.destroy();
    } catch {
      // Teardown is best-effort and must remain idempotent during unmount.
    }
  };

  const failFatal = () => {
    reauthenticationPending = false;
    options.store.markFatal();
    teardownProvider();
  };

  const finishReauthenticationIfReady = () => {
    if (reauthenticationAuthenticated && reauthenticationSynced) {
      reauthenticationPending = false;
    }
  };

  const scheduleStorageDelay = (id: number) => {
    if (storageDelayTimer !== undefined) return;
    storageDelayTimer = timers.set(() => {
      storageDelayTimer = undefined;
      if (isCurrent(id)) options.store.markStorageDelayed();
    }, STORAGE_DELAY_MS);
  };

  const acknowledgePendingUpdate = (pending: PendingUpdate) => {
    pending.acknowledged = true;
    if (pending.checksum) options.store.acknowledgeDurableUpdate(pending.checksum);
  };

  const hasPendingUpdateFrames = () => (
    pendingUpdates.length > 0 || reconnectBarrierUpdates.length > 0
  );

  const acknowledgeNextDurableUpdate = (id: number) => {
    if (!isCurrent(id)) return;
    if (awaitingTransportBarrier) {
      awaitingTransportBarrier = false;
      for (const pending of reconnectBarrierUpdates.splice(0)) {
        acknowledgePendingUpdate(pending);
      }
      if (!hasPendingUpdateFrames()) clearStorageDelayTimer();
      return;
    }
    const pending = pendingUpdates.shift();
    if (!pending) return;
    acknowledgePendingUpdate(pending);
    if (!hasPendingUpdateFrames()) clearStorageDelayTimer();
  };

  const trackOutgoingUpdate = (
    id: number,
    update: Uint8Array,
    kind: "incremental" | "sync-step-2",
  ) => {
    if (!isCurrent(id)) return;
    // Hocuspocus 4.4 sends the handshake SyncStep2 from MessageReceiver
    // directly through the websocket, bypassing onOutgoingMessage. The first
    // durable SyncStatus on each transport is tracked as the barrier instead.
    if (kind === "sync-step-2") return;
    const pending: PendingUpdate = {
      acknowledged: false,
    };
    pendingUpdates.push(pending);
    // SHA-256 is asynchronous in browsers. Publish the pending update before
    // hashing so route/unload guards cannot miss edits in that interval.
    options.store.beginLocalUpdate();
    void checksum(update).then((value) => {
      if (!isCurrent(id)) return;
      options.store.resolvePendingLocalUpdate(value);
      options.store.markAwaitingDurableAcknowledgement(value);
      pending.checksum = value;
      if (pending.acknowledged) options.store.acknowledgeDurableUpdate(value);
    }).catch(() => {
      if (isCurrent(id)) {
        options.store.discardPendingLocalUpdate();
        failFatal();
      }
    });
  };

  const scheduleCapabilityRefresh = (id: number, expiresInSeconds: number) => {
    clearRefreshTimer();
    const delay = Math.max(1_000, expiresInSeconds * 1_000 - REFRESH_LEAD_TIME_MS);
    refreshTimer = timers.set(async () => {
      refreshTimer = undefined;
      if (!isCurrent(id)) return;
      await refreshCapability().catch(() => undefined);
    }, delay);
  };

  const createEvents = (id: number): CollaborationProviderFactoryOptions["events"] => ({
    authenticated(scope) {
      if (!isCurrent(id)) return;
      if (reauthenticationPending && !acceptingReauthenticationEvents) return;
      options.store.markAuthenticated(scope);
      if (reauthenticationPending) {
        reauthenticationAuthenticated = true;
        finishReauthenticationIfReady();
      }
    },
    authenticationFailed(reason) {
      if (!isCurrent(id)) return;
      handleAuthorizationFailure(id, reason);
    },
    closed(event) {
      if (!isCurrent(id)) return;
      handleClose(id, event.reason);
    },
    durableAcknowledged() {
      acknowledgeNextDurableUpdate(id);
    },
    outgoingUpdate(update, kind) {
      trackOutgoingUpdate(id, update, kind);
    },
    status(status) {
      if (!isCurrent(id)) return;
      if (status === "connecting") {
        awaitingTransportBarrier = true;
        reconnectBarrierUpdates.push(...pendingUpdates.splice(0));
        if (reauthenticationPending && reauthenticationSawDisconnect) {
          acceptingReauthenticationEvents = true;
          reauthenticationAuthenticated = false;
          reauthenticationSynced = false;
          options.store.beginReauthenticating();
        }
        const snapshot = options.store.getSnapshot();
        options.store.beginConnecting({
          reconnecting: snapshot.hasCompletedInitialSync || snapshot.status !== "connecting",
        });
      } else if (status === "disconnected") {
        // A checksum-less SyncStatus can only be associated with frames from
        // the active transport. Preserve their logical updates, but let the
        // next SyncStep2 acknowledgement act as the durable state barrier.
        reconnectBarrierUpdates.push(...pendingUpdates.splice(0));
        if (reauthenticationPending) {
          acceptingReauthenticationEvents = false;
          reauthenticationSawDisconnect = true;
        }
        options.store.markDisconnected();
      }
    },
    synced(state) {
      if (!isCurrent(id) || !state) return;
      if (reauthenticationPending && !acceptingReauthenticationEvents) return;
      options.store.markTransportSynced();
      if (reauthenticationPending) {
        reauthenticationSynced = true;
        finishReauthenticationIfReady();
      }
    },
    unsyncedChanges(number) {
      if (!isCurrent(id) || !Number.isSafeInteger(number) || number < 0) {
        if (isCurrent(id)) failFatal();
        return;
      }
      if (number > 0) scheduleStorageDelay(id);
      else if (!hasPendingUpdateFrames()) clearStorageDelayTimer();
    },
  });

  const beginRecovery = (id: number) => {
    void refreshCapability().catch(() => {
      if (isCurrent(id) && options.store.getSnapshot().status !== "fatal") {
        options.store.markAuthorizationExpired();
      }
    });
  };

  const handleAuthorizationFailure = (id: number, reason: string) => {
    if (
      reauthenticationPending
      && acceptingReauthenticationEvents
      && (reason === "authorization_expired" || reason === "authorization_revoked")
    ) {
      failFatal();
      return;
    }
    if (reauthenticationPending && !acceptingReauthenticationEvents) return;
    if (reason === "authorization_expired") {
      options.store.markAuthorizationExpired();
      beginRecovery(id);
      return;
    }
    if (reason === "authorization_revoked") {
      options.store.markAuthorizationExpired();
      beginRecovery(id);
      return;
    }
    if (reason === "server_draining") {
      options.store.markDisconnected();
      return;
    }
    failFatal();
  };

  const handleClose = (id: number, reason: string) => {
    if (
      reauthenticationPending
      && acceptingReauthenticationEvents
      && (reason === "authorization_expired" || reason === "authorization_revoked")
    ) {
      failFatal();
      return;
    }
    if (
      reauthenticationPending
      && !acceptingReauthenticationEvents
      && (reason === "authorization_expired" || reason === "authorization_revoked")
    ) return;
    if (reason === "authorization_expired") {
      options.store.markAuthorizationExpired();
      beginRecovery(id);
      return;
    }
    if (reason === "authorization_revoked") {
      options.store.markAuthorizationExpired();
      beginRecovery(id);
      return;
    }
    if (reason === "server_draining") {
      options.store.markDisconnected();
      return;
    }
    if (reason === "storage_unavailable") {
      options.store.markDisconnected();
      options.store.markStorageDelayed();
      beginRecovery(id);
      return;
    }
    if (reason === "room_rotated" || reason === "schema_changed") {
      failFatal();
      return;
    }
    if (reason.length === 0) {
      options.store.markDisconnected();
      return;
    }
    failFatal();
  };

  const issueExactCapability = async () => {
    let issued: CollaborationCapability;
    try {
      issued = await options.issueCapability();
    } catch {
      throw new CollaborationSessionError("capability_unavailable");
    }
    if (destroyed) throw new CollaborationSessionError("destroyed");
    if (!isCapabilityValid(issued, options.room)) {
      throw new CollaborationSessionError("capability_invalid");
    }
    return issued;
  };

  const refreshCapability = (): Promise<void> => {
    if (destroyed) return Promise.reject(new CollaborationSessionError("destroyed"));
    if (!providerHandle) return Promise.reject(new CollaborationSessionError("transport_unavailable"));
    if (refreshPromise) {
      return refreshPromise;
    }
    const id = lifecycleId;
    // A previously authenticated capability is no longer authority once its
    // replacement starts. Revoke local writes before waiting on the issuer so
    // a write-to-read downgrade cannot race the refresh request.
    options.store.beginReauthenticating();
    acceptingReauthenticationEvents = false;
    reauthenticationAuthenticated = false;
    reauthenticationPending = true;
    reauthenticationSawDisconnect = false;
    reauthenticationSynced = false;
    // A Hocuspocus reconnect timer may already be queued before reauthentication
    // starts. Remove the old credential synchronously so that attempt can only
    // fail closed while the replacement capability is in flight.
    capability = undefined;
    refreshPromise = (async () => {
      try {
        let next: CollaborationCapability | undefined;
        await providerHandle!.reauthenticate(
          async () => {
            next = await issueExactCapability();
            if (!isCurrent(id)) throw new CollaborationSessionError("destroyed");
            capability = next;
          },
          () => {
            if (!isCurrent(id)) return;
            acceptingReauthenticationEvents = false;
            reauthenticationSawDisconnect = true;
            options.store.beginReauthenticating();
          },
        );
        if (!isCurrent(id)) throw new CollaborationSessionError("destroyed");
        if (!next) throw new CollaborationSessionError("capability_unavailable");
        scheduleCapabilityRefresh(id, next.expiresInSeconds);
      } catch (error) {
        if (error instanceof CollaborationSessionError && error.category === "capability_invalid") {
          failFatal();
        } else if (!destroyed && isCurrent(id)) {
          reauthenticationPending = false;
          options.store.markAuthorizationExpired();
        }
        throw normalizeSessionError(error, "capability_unavailable");
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  };

  const connect = (): Promise<void> => {
    if (destroyed) return Promise.reject(new CollaborationSessionError("destroyed"));
    if (providerHandle) return Promise.resolve();
    if (connectPromise) return connectPromise;
    options.store.beginConnecting({ reconnecting: hasAttemptedConnect });
    hasAttemptedConnect = true;
    connectPromise = (async () => {
      try {
        capability = await issueExactCapability();
        if (destroyed) throw new CollaborationSessionError("destroyed");
        const id = ++lifecycleId;
        providerHandle = providerFactory({
          document: options.document,
          events: createEvents(id),
          getToken: () => capability?.token ?? "",
          room: options.room,
          url: options.url,
        });
        scheduleCapabilityRefresh(id, capability.expiresInSeconds);
        await providerHandle.connect();
        if (!isCurrent(id)) throw new CollaborationSessionError("destroyed");
      } catch (error) {
        if (error instanceof CollaborationSessionError && error.category === "capability_invalid") {
          failFatal();
        } else if (!destroyed) {
          teardownProvider();
          options.store.markDisconnected();
        }
        throw normalizeSessionError(error, "transport_unavailable");
      } finally {
        connectPromise = undefined;
      }
    })();
    return connectPromise;
  };

  return {
    connect,
    document: options.document,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      teardownProvider();
      capability = undefined;
      pendingUpdates.length = 0;
      reconnectBarrierUpdates.length = 0;
    },
    get provider() {
      return providerHandle?.provider ?? null;
    },
    refreshCapability() {
      return refreshCapability();
    },
    room: options.room,
    store: options.store,
  };
}

export function createHocuspocusProviderHandle(
  options: CollaborationProviderFactoryOptions,
): CollaborationProviderHandle {
  const websocketProvider = new HocuspocusProviderWebsocket({
    autoConnect: false,
    url: options.url,
  });
  const provider = new HocuspocusProvider({
    document: options.document,
    flushDelay: false,
    name: options.room,
    onAuthenticated: ({ scope }) => options.events.authenticated(scope),
    onAuthenticationFailed: ({ reason }) => options.events.authenticationFailed(reason),
    onClose: ({ event }) => options.events.closed(event),
    onMessage: ({ event }) => {
      if (isDurableAcknowledgement(event.data, options.room)) {
        options.events.durableAcknowledged();
      }
    },
    onOutgoingMessage: ({ message }) => {
      const outgoing = readOutgoingUpdate(message.toUint8Array(), options.room);
      if (outgoing) options.events.outgoingUpdate(outgoing.update, outgoing.kind);
    },
    onStatus: ({ status }) => options.events.status(status),
    onSynced: ({ state }) => options.events.synced(state),
    onUnsyncedChanges: ({ number }) => options.events.unsyncedChanges(number),
    token: options.getToken,
    websocketProvider,
  });
  if (!provider.awareness) {
    provider.destroy();
    websocketProvider.destroy();
    throw new CollaborationSessionError("transport_unavailable");
  }
  const collaborationProvider = provider as CollaborationHocuspocusProvider;
  let destroyed = false;
  let rejectDisconnectWait: ((error: CollaborationSessionError) => void) | undefined;
  const quiesceTransport = async () => {
    if (destroyed) throw new CollaborationSessionError("destroyed");
    if (websocketProvider.status === WebSocketStatus.Disconnected) {
      websocketProvider.disconnect();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        websocketProvider.off("status", onStatus);
        rejectDisconnectWait = undefined;
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onStatus = ({ status }: { status: WebSocketStatus }) => {
        if (status === WebSocketStatus.Disconnected) finish();
      };
      rejectDisconnectWait = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      websocketProvider.on("status", onStatus);
      websocketProvider.disconnect();
      if (websocketProvider.status === WebSocketStatus.Disconnected) finish();
    });
    if (destroyed) throw new CollaborationSessionError("destroyed");
  };
  provider.attach();
  return {
    async connect() {
      await websocketProvider.connect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rejectDisconnectWait?.(new CollaborationSessionError("destroyed"));
      rejectDisconnectWait = undefined;
      try {
        provider.destroy();
      } finally {
        websocketProvider.destroy();
      }
    },
    provider: collaborationProvider,
    async reauthenticate(prepareToken, onTransportReset) {
      if (destroyed) throw new CollaborationSessionError("destroyed");
      await quiesceTransport();
      try {
        await prepareToken();
      } finally {
        // A delayed Hocuspocus auto-retry may have started while the issuer was
        // pending. Stop and close it before accepting fresh transport events.
        await quiesceTransport();
      }
      if (destroyed) throw new CollaborationSessionError("destroyed");
      onTransportReset();
      await websocketProvider.connect();
    },
  };
}

function readOutgoingUpdate(
  raw: Uint8Array,
  expectedRoom: string,
): { kind: "incremental" | "sync-step-2"; update: Uint8Array } | null {
  try {
    const decoder = decoding.createDecoder(raw);
    if (decoding.readVarString(decoder) !== expectedRoom) return null;
    const outerType = decoding.readVarUint(decoder);
    if (outerType !== 0 && outerType !== 4) return null;
    const syncType = decoding.readVarUint(decoder);
    if (syncType !== 1 && syncType !== 2) return null;
    const update = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) return null;
    return {
      kind: syncType === 1 ? "sync-step-2" : "incremental",
      update,
    };
  } catch {
    return null;
  }
}

function isDurableAcknowledgement(raw: unknown, expectedRoom: string) {
  if (!(raw instanceof ArrayBuffer)) return false;
  try {
    const decoder = decoding.createDecoder(new Uint8Array(raw));
    if (decoding.readVarString(decoder) !== expectedRoom) return false;
    if (decoding.readVarUint(decoder) !== 8) return false;
    const applied = decoding.readVarInt(decoder);
    return applied === 1 && !decoding.hasContent(decoder);
  } catch {
    return false;
  }
}

function isCapabilityValid(capability: CollaborationCapability, expectedRoom: string) {
  return capability !== null
    && typeof capability === "object"
    && capability.room === expectedRoom
    && Number.isSafeInteger(capability.expiresInSeconds)
    && capability.expiresInSeconds > 0
    && capability.expiresInSeconds <= MAX_CAPABILITY_LIFETIME_SECONDS
    && typeof capability.token === "string"
    && capability.token.length > 0
    && new TextEncoder().encode(capability.token).byteLength <= MAX_TOKEN_BYTES;
}

function assertExpectedRoom(room: string) {
  try {
    const parsed = parseCollaborationRoomName(room);
    if (parsed.generation < 1) throw new Error();
  } catch {
    throw new CollaborationSessionError("capability_invalid");
  }
}

function assertWebSocketUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) {
      throw new Error();
    }
  } catch {
    throw new CollaborationSessionError("transport_unavailable");
  }
}

async function sha256(update: Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    throw new CollaborationSessionError("transport_unavailable");
  }
  const source = new Uint8Array(update);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSessionError(
  error: unknown,
  fallback: CollaborationSessionErrorCategory,
) {
  return error instanceof CollaborationSessionError
    ? error
    : new CollaborationSessionError(fallback);
}

const browserTimers: TimerApi = {
  clear(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  set(callback, delay) {
    return globalThis.setTimeout(() => {
      void callback();
    }, delay);
  },
};
