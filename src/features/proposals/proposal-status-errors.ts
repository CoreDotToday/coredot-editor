export const COLLABORATION_ANCHOR_REQUIRED_REASON = "collaboration_anchor_required" as const;

export class ProposalStatusUpdateConflictError extends Error {
  readonly reason = COLLABORATION_ANCHOR_REQUIRED_REASON;

  constructor() {
    super("Collaboration proposal anchor is required");
    this.name = "ProposalStatusUpdateConflictError";
  }
}
