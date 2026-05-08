"use client";

import type { AiProposalRecord } from "@/db/schema";

export type AiReviewProposal = Pick<
  AiProposalRecord,
  "id" | "targetText" | "replacementText" | "explanation" | "status"
>;

type AiReviewPanelProps = {
  errorMessage: string;
  isReviewing: boolean;
  proposals: AiReviewProposal[];
  selectedTemplateName: string;
  onReviewDocument: () => void;
  onUpdateProposalStatus: (proposalId: string, status: AiReviewProposal["status"]) => void;
};

const statusStyles: Record<AiReviewProposal["status"], string> = {
  pending: "border-zinc-300 bg-zinc-50 text-zinc-700",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
};

function formatStatus(status: AiReviewProposal["status"]) {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function AiReviewPanel({
  errorMessage,
  isReviewing,
  onReviewDocument,
  onUpdateProposalStatus,
  proposals,
  selectedTemplateName,
}: AiReviewPanelProps) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-950">AI Review</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {selectedTemplateName ? `Template: ${selectedTemplateName}` : "Select a template to review."}
          </p>
        </div>
        <button
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-zinc-950 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
          disabled={isReviewing || !selectedTemplateName}
          onClick={onReviewDocument}
          type="button"
        >
          {isReviewing ? "Reviewing..." : "Review document"}
        </button>
      </div>

      {errorMessage ? (
        <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {proposals.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-zinc-500">No review proposals yet.</p>
      ) : (
        <ul className="mt-5 space-y-4">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="border-t border-zinc-200 pt-4">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={[
                    "rounded-full border px-2 py-0.5 text-xs font-medium",
                    statusStyles[proposal.status],
                  ].join(" ")}
                >
                  {formatStatus(proposal.status)}
                </span>
                {proposal.status === "pending" ? (
                  <div className="flex gap-2">
                    <button
                      aria-label={`Accept proposal for ${proposal.targetText}`}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => onUpdateProposalStatus(proposal.id, "accepted")}
                      type="button"
                    >
                      Accept
                    </button>
                    <button
                      aria-label={`Reject proposal for ${proposal.targetText}`}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => onUpdateProposalStatus(proposal.id, "rejected")}
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-3 space-y-2 text-sm leading-6">
                <p className="text-zinc-500">{proposal.explanation}</p>
                <p className="text-zinc-700">
                  <span className="font-medium text-zinc-950">Replace:</span> {proposal.targetText}
                </p>
                <p className="text-zinc-700">
                  <span className="font-medium text-zinc-950">With:</span> {proposal.replacementText}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
