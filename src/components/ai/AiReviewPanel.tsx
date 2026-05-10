"use client";

import type { AiProposalRecord } from "@/db/schema";
import { editorMessages, formatEditorMessage, type EditorMessages } from "@/features/i18n/editor-language";

export type AiReviewProposal = Pick<
  AiProposalRecord,
  "id" | "targetText" | "replacementText" | "explanation" | "status"
>;

type AiReviewPanelProps = {
  errorMessage: string;
  isReviewing: boolean;
  messages?: EditorMessages["aiReview"];
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

export function AiReviewPanel({
  errorMessage,
  isReviewing,
  messages = editorMessages.en.aiReview,
  onReviewDocument,
  onUpdateProposalStatus,
  proposals,
  selectedTemplateName,
}: AiReviewPanelProps) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-950">{messages.title}</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {selectedTemplateName
              ? formatEditorMessage(messages.template, { templateName: selectedTemplateName })
              : messages.selectTemplate}
          </p>
        </div>
        <button
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-zinc-950 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
          disabled={isReviewing || !selectedTemplateName}
          onClick={onReviewDocument}
          type="button"
        >
          {isReviewing ? messages.reviewing : messages.reviewDocument}
        </button>
      </div>

      {errorMessage ? (
        <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {proposals.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-zinc-500">{messages.noProposals}</p>
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
                  {messages[proposal.status]}
                </span>
                {proposal.status === "pending" ? (
                  <div className="flex gap-2">
                    <button
                      aria-label={formatEditorMessage(messages.acceptProposal, { targetText: proposal.targetText })}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => onUpdateProposalStatus(proposal.id, "accepted")}
                      type="button"
                    >
                      {messages.accept}
                    </button>
                    <button
                      aria-label={formatEditorMessage(messages.rejectProposal, { targetText: proposal.targetText })}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => onUpdateProposalStatus(proposal.id, "rejected")}
                      type="button"
                    >
                      {messages.reject}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-3 space-y-2 text-sm leading-6">
                <p className="text-zinc-500">{proposal.explanation}</p>
                <p className="text-zinc-700">
                  <span className="font-medium text-zinc-950">{messages.replace}</span> {proposal.targetText}
                </p>
                <p className="text-zinc-700">
                  <span className="font-medium text-zinc-950">{messages.with}</span> {proposal.replacementText}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
