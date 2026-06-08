import type { TiptapJson } from "@/db/schema";
import {
  insertTextBelowTargetInTiptapJson,
  replaceTextInTiptapJson,
  type TiptapReplaceResult,
} from "@/features/documents/tiptap-replace";

export type ProposalApplyMode = "replace" | "insert_below";
export type ProposalSource = "selection" | "review";

export type ProposalSelectionRange = {
  from: number;
  to: number;
};

export type ProposalApplyOptions = {
  occurrenceIndex?: number;
  requireSelectionRangeMatch?: boolean;
  selectionRange?: ProposalSelectionRange;
};

export type ProposalOperationSnapshot = {
  command?: string;
  contentSignature?: string;
  occurrenceIndex?: number;
  scope?: "selection" | "currentBlock" | "document";
  selectedText?: string;
  selectionRange?: ProposalSelectionRange;
};

export type ProposalTransactionContext = ProposalOperationSnapshot;

export type ProposalTransactionProposal = {
  defaultApplyMode?: ProposalApplyMode | null;
  id: string;
  occurrenceIndex?: number | null;
  replacementText: string;
  source?: ProposalSource | null;
  targetFrom?: number | null;
  targetText: string;
  targetTo?: number | null;
};

export function getProposalSelectionRange(
  proposal: { targetFrom?: number | null; targetTo?: number | null },
  context?: ProposalTransactionContext,
) {
  if (typeof proposal.targetFrom === "number" && typeof proposal.targetTo === "number") {
    return { from: proposal.targetFrom, to: proposal.targetTo };
  }

  return context?.selectionRange;
}

export function createProposalApplyOptions(
  occurrenceIndex: number | null | undefined,
  selectionRange: ProposalSelectionRange | undefined,
  source?: ProposalSource | null,
): ProposalApplyOptions | undefined {
  const requireSelectionRangeMatch = (source === "selection" || Boolean(selectionRange)) && Boolean(selectionRange);
  return occurrenceIndex === null || occurrenceIndex === undefined
    ? selectionRange ? { requireSelectionRangeMatch, selectionRange } : undefined
    : { occurrenceIndex, ...(selectionRange ? { requireSelectionRangeMatch, selectionRange } : {}) };
}

export function createProposalContentSignature(contentJson: TiptapJson) {
  return JSON.stringify(contentJson);
}

export function isProposalSnapshotStale(
  context: ProposalOperationSnapshot | undefined,
  contentJson: TiptapJson,
) {
  return Boolean(context?.contentSignature && context.contentSignature !== createProposalContentSignature(contentJson));
}

export function getProposalApplicationOrder<TProposal extends { id: string; targetFrom?: number | null; targetTo?: number | null }>(
  proposals: TProposal[],
  selectionProposalContexts: Partial<Record<string, ProposalTransactionContext>>,
) {
  return [...proposals].sort((left, right) => {
    const leftRange = getProposalSelectionRange(left, selectionProposalContexts[left.id]);
    const rightRange = getProposalSelectionRange(right, selectionProposalContexts[right.id]);
    if (leftRange && rightRange) {
      return rightRange.from - leftRange.from;
    }

    if (leftRange) {
      return -1;
    }

    if (rightRange) {
      return 1;
    }

    return 0;
  });
}

export function applyProposalToTiptapDraft(
  contentJson: TiptapJson,
  proposal: ProposalTransactionProposal,
  context?: ProposalTransactionContext,
  applyMode: ProposalApplyMode = proposal.defaultApplyMode ?? "replace",
): TiptapReplaceResult {
  const occurrenceIndex = proposal.occurrenceIndex ?? context?.occurrenceIndex;
  const selectionRange = getProposalSelectionRange(proposal, context);
  const applyOptions = createProposalApplyOptions(occurrenceIndex, selectionRange, proposal.source);

  return applyMode === "insert_below"
    ? insertTextBelowTargetInTiptapJson(contentJson, proposal.targetText, proposal.replacementText, applyOptions)
    : replaceTextInTiptapJson(contentJson, proposal.targetText, proposal.replacementText, applyOptions);
}
