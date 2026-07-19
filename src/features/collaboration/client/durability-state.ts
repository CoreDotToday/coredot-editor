import type { CollaborationSessionSnapshot } from "./session-store";

export function hasPendingCollaborationUpdates(snapshot: CollaborationSessionSnapshot) {
  return snapshot.pendingLocalUpdateCount > 0
    || snapshot.pendingLocalChecksums.length > 0
    || snapshot.pendingDurableAcknowledgementChecksums.length > 0;
}
