export type CollaborationSessionStatus =
  | "authorization_expired"
  | "connecting"
  | "fatal"
  | "offline_pending"
  | "read_only"
  | "reconnecting"
  | "storage_delayed"
  | "synced";

export type CollaborationSessionSnapshot = Readonly<{
  hasCompletedInitialSync: boolean;
  pendingDurableAcknowledgementChecksums: readonly string[];
  pendingLocalChecksums: readonly string[];
  pendingLocalUpdateCount: number;
  permission: "read" | "write" | null;
  status: CollaborationSessionStatus;
  transportSynced: boolean;
  writable: boolean;
}>;

type SessionLifecycle =
  | "authorization_expired"
  | "connecting"
  | "fatal"
  | "reconnecting";

type MutableSessionState = {
  hasCompletedInitialSync: boolean;
  lifecycle: SessionLifecycle;
  pendingDurableAcknowledgementChecksums: string[];
  pendingLocalChecksums: string[];
  pendingLocalUpdateCount: number;
  permission: "read" | "write" | null;
  storageDelayed: boolean;
  transportSynced: boolean;
};

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export function createCollaborationSessionStore() {
  const listeners = new Set<() => void>();
  const state: MutableSessionState = {
    hasCompletedInitialSync: false,
    lifecycle: "connecting",
    pendingDurableAcknowledgementChecksums: [],
    pendingLocalChecksums: [],
    pendingLocalUpdateCount: 0,
    permission: null,
    storageDelayed: false,
    transportSynced: false,
  };
  let snapshot = createSnapshot(state);

  const publish = () => {
    const next = createSnapshot(state);
    if (snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    beginLocalUpdate() {
      state.pendingLocalUpdateCount += 1;
      publish();
    },

    acknowledgeDurableUpdate(checksum: string) {
      assertChecksum(checksum);
      const index = state.pendingDurableAcknowledgementChecksums.indexOf(checksum);
      if (index < 0) return;
      state.pendingDurableAcknowledgementChecksums.splice(index, 1);
      if (state.pendingDurableAcknowledgementChecksums.length === 0) {
        state.storageDelayed = false;
      }
      publish();
    },

    beginConnecting(options: { reconnecting?: boolean } = {}) {
      if (state.lifecycle === "fatal") return;
      state.lifecycle = options.reconnecting ? "reconnecting" : "connecting";
      if (!options.reconnecting || !state.hasCompletedInitialSync) {
        state.permission = null;
      }
      state.storageDelayed = false;
      state.transportSynced = false;
      publish();
    },

    getSnapshot() {
      return snapshot;
    },

    discardPendingLocalUpdate() {
      if (state.pendingLocalUpdateCount === 0) return;
      state.pendingLocalUpdateCount -= 1;
      publish();
    },

    markAuthenticated(scope: "read-write" | "readonly") {
      if (isTerminal(state)) return;
      state.permission = scope === "read-write" ? "write" : "read";
      if (state.transportSynced) state.hasCompletedInitialSync = true;
      publish();
    },

    markAuthorizationExpired() {
      if (state.lifecycle === "fatal") return;
      state.lifecycle = "authorization_expired";
      state.permission = null;
      state.transportSynced = false;
      publish();
    },

    markAwaitingDurableAcknowledgement(checksum: string) {
      assertChecksum(checksum);
      const localIndex = state.pendingLocalChecksums.indexOf(checksum);
      if (localIndex < 0) return;
      state.pendingLocalChecksums.splice(localIndex, 1);
      state.pendingDurableAcknowledgementChecksums.push(checksum);
      publish();
    },

    markDisconnected() {
      if (isTerminal(state)) return;
      state.lifecycle = "reconnecting";
      if (!state.hasCompletedInitialSync) state.permission = null;
      state.transportSynced = false;
      publish();
    },

    markFatal() {
      state.lifecycle = "fatal";
      state.permission = null;
      state.transportSynced = false;
      publish();
    },

    markStorageDelayed() {
      if (isTerminal(state)) return;
      state.storageDelayed = true;
      publish();
    },

    markSchemaIncompatible() {
      if (state.lifecycle === "fatal") return;
      state.permission = "read";
      state.transportSynced = true;
      publish();
    },

    markTransportSynced() {
      if (isTerminal(state)) return;
      state.transportSynced = true;
      if (state.permission !== null) state.hasCompletedInitialSync = true;
      publish();
    },

    recordLocalUpdate(checksum: string) {
      assertChecksum(checksum);
      state.pendingLocalChecksums.push(checksum);
      publish();
    },

    resolvePendingLocalUpdate(checksum: string) {
      assertChecksum(checksum);
      if (state.pendingLocalUpdateCount === 0) {
        throw new Error("No pending collaboration update");
      }
      state.pendingLocalUpdateCount -= 1;
      state.pendingLocalChecksums.push(checksum);
      publish();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CollaborationSessionStore = ReturnType<typeof createCollaborationSessionStore>;

function createSnapshot(state: MutableSessionState): CollaborationSessionSnapshot {
  const status = deriveStatus(state);
  return Object.freeze({
    hasCompletedInitialSync: state.hasCompletedInitialSync,
    pendingDurableAcknowledgementChecksums: Object.freeze([
      ...state.pendingDurableAcknowledgementChecksums,
    ]),
    pendingLocalChecksums: Object.freeze([...state.pendingLocalChecksums]),
    pendingLocalUpdateCount: state.pendingLocalUpdateCount,
    permission: state.permission,
    status,
    transportSynced: state.transportSynced,
    writable: state.permission === "write" && (
      (
        state.transportSynced
        && (status === "synced" || status === "storage_delayed")
      )
      || (
        state.hasCompletedInitialSync
        && (
          status === "reconnecting"
          || status === "offline_pending"
          || status === "storage_delayed"
        )
      )
    ),
  });
}

function deriveStatus(state: MutableSessionState): CollaborationSessionStatus {
  if (state.lifecycle === "fatal") return "fatal";
  if (state.lifecycle === "authorization_expired") return "authorization_expired";
  if (
    state.lifecycle === "reconnecting"
    && (
      state.pendingLocalChecksums.length > 0
      || state.pendingLocalUpdateCount > 0
      || state.pendingDurableAcknowledgementChecksums.length > 0
    )
  ) {
    return "offline_pending";
  }
  if (state.storageDelayed) return "storage_delayed";
  if (!state.transportSynced || state.permission === null) return state.lifecycle;
  if (state.permission === "read") return "read_only";
  return "synced";
}

function isTerminal(state: MutableSessionState) {
  return state.lifecycle === "authorization_expired" || state.lifecycle === "fatal";
}

function assertChecksum(checksum: string): void {
  if (!CHECKSUM_PATTERN.test(checksum)) {
    throw new Error("Invalid collaboration update checksum");
  }
}

function snapshotsEqual(
  previous: CollaborationSessionSnapshot,
  next: CollaborationSessionSnapshot,
) {
  return previous.permission === next.permission
    && previous.hasCompletedInitialSync === next.hasCompletedInitialSync
    && previous.status === next.status
    && previous.transportSynced === next.transportSynced
    && previous.writable === next.writable
    && previous.pendingLocalUpdateCount === next.pendingLocalUpdateCount
    && arraysEqual(
      previous.pendingLocalChecksums,
      next.pendingLocalChecksums,
    )
    && arraysEqual(
      previous.pendingDurableAcknowledgementChecksums,
      next.pendingDurableAcknowledgementChecksums,
    );
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
