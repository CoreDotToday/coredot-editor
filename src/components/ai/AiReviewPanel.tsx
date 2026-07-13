"use client";

import type { AiProposalRecord } from "@/db/schema";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import { ProposalRedline } from "./ProposalRedline";

export type AiReviewProposal = Pick<
  AiProposalRecord,
  "id" | "targetText" | "replacementText" | "explanation" | "status"
> &
  Partial<
    Pick<
      AiProposalRecord,
      "source" | "command" | "occurrenceIndex" | "targetFrom" | "targetTo" | "defaultApplyMode" | "appliedMode"
    >
  > & { isTruncated?: boolean };
export type AiProposalApplyMode = "replace" | "insert_below";
export type AiReviewSummary = {
  findingCount: number;
  proposalCount: number;
  skippedProposalCount: number;
  summary: string;
};

type AiReviewPanelProps = {
  ariaLabelledBy?: string;
  activeProposalId?: string | null;
  errorMessage: string;
  id?: string;
  isReviewing: boolean;
  messages?: EditorMessages["aiReview"];
  proposals: AiReviewProposal[];
  reviewSummary?: AiReviewSummary | null;
  selectedTemplateName: string;
  onBulkUpdateProposalStatus?: (status: "accepted" | "rejected") => void;
  onFocusProposal?: (proposalId: string) => void;
  onLoadMore?: () => void;
  onLoadProposalDetail?: (proposalId: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onReviewDocument: () => void;
  onUpdateProposalStatus: (
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode?: AiProposalApplyMode,
  ) => void;
};

const statusStyles: Record<AiReviewProposal["status"], string> = {
  pending: "border-zinc-300 bg-zinc-50 text-zinc-700",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
};

export function AiReviewPanel({
  ariaLabelledBy,
  activeProposalId = null,
  errorMessage,
  id,
  isReviewing,
  onBulkUpdateProposalStatus,
  onFocusProposal,
  onLoadMore,
  onLoadProposalDetail,
  hasMore = false,
  isLoadingMore = false,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiReview,
  onReviewDocument,
  onUpdateProposalStatus,
  proposals,
  reviewSummary = null,
  selectedTemplateName,
}: AiReviewPanelProps) {
  const pendingProposalCount = proposals.filter((proposal) => proposal.status === "pending").length;

  return (
    <section
      aria-labelledby={ariaLabelledBy}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
      id={id}
      role={id && ariaLabelledBy ? "tabpanel" : undefined}
    >
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

      {reviewSummary ? (
        <section className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">{messages.reviewSummaryTitle}</h3>
          {reviewSummary.summary ? (
            <p className="mt-2 text-sm leading-6 text-zinc-700">{reviewSummary.summary}</p>
          ) : null}
          <p className="mt-2 text-xs font-medium text-zinc-500">
            {formatEditorMessage(messages.summaryCounts, {
              proposalCount: String(reviewSummary.proposalCount),
              skippedCount: String(reviewSummary.skippedProposalCount),
            })}
          </p>
        </section>
      ) : null}

      {proposals.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-zinc-500">
          {reviewSummary ? messages.noApplicableProposals : messages.noProposals}
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          {!hasMore && pendingProposalCount > 0 && onBulkUpdateProposalStatus ? (
            <div className="flex flex-wrap justify-end gap-2">
              <button
                aria-label={messages.acceptAllPendingProposals}
                className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={() => onBulkUpdateProposalStatus("accepted")}
                type="button"
              >
                {messages.acceptAllPending}
              </button>
              <button
                aria-label={messages.rejectAllPendingProposals}
                className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={() => onBulkUpdateProposalStatus("rejected")}
                type="button"
              >
                {messages.rejectAllPending}
              </button>
            </div>
          ) : null}

          <ul className="space-y-4">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className={[
                  "border-t pt-4",
                  activeProposalId === proposal.id ? "border-sky-300 bg-sky-50/40 px-2 pb-2" : "border-zinc-200",
                ].join(" ")}
              >
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
                    <div className="flex flex-wrap justify-end gap-2">
                      {onFocusProposal ? (
                        <button
                          aria-label={formatEditorMessage(messages.showProposalInDocument, {
                            targetText: proposal.targetText,
                          })}
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                          onClick={() => onFocusProposal(proposal.id)}
                          type="button"
                        >
                          {messages.showInDocument}
                        </button>
                      ) : null}
                      <button
                        aria-label={formatEditorMessage(messages.insertBelowProposal, {
                          targetText: proposal.targetText,
                        })}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                        onClick={() => onUpdateProposalStatus(proposal.id, "accepted", "insert_below")}
                        type="button"
                      >
                        {messages.insertBelow}
                      </button>
                      <button
                        aria-label={formatEditorMessage(messages.replaceProposal, { targetText: proposal.targetText })}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                        onClick={() => onUpdateProposalStatus(proposal.id, "accepted", "replace")}
                        type="button"
                      >
                        {messages.replaceAction}
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
                  {proposal.isTruncated ? (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <span>일부 내용 미리보기</span>
                      {onLoadProposalDetail ? (
                        <button
                          className="font-medium underline underline-offset-2"
                          onClick={() => onLoadProposalDetail(proposal.id)}
                          type="button"
                        >
                          전체 제안 보기
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-zinc-500">{proposal.explanation}</p>
                  <p className="text-zinc-700">
                    <span className="font-medium text-zinc-950">{getTargetLabel(proposal, messages)}</span>{" "}
                    {proposal.targetText}
                  </p>
                  <p className="text-zinc-700">
                    <span className="font-medium text-zinc-950">{getReplacementLabel(proposal, messages)}</span>{" "}
                    {proposal.replacementText}
                  </p>
                  <ProposalRedline
                    messages={messages}
                    originalText={proposal.targetText}
                    replacementText={proposal.replacementText}
                  />
                </div>
              </li>
            ))}
          </ul>
          {hasMore && onLoadMore ? (
            <button
              className="mt-4 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              type="button"
            >
              {isLoadingMore ? "불러오는 중..." : "이전 제안 더 보기"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function getTargetLabel(proposal: AiReviewProposal, messages: EditorMessages["aiReview"]) {
  const mode = proposal.appliedMode ?? proposal.defaultApplyMode;
  return mode === "insert_below" ? messages.insertBelowTarget : messages.replace;
}

function getReplacementLabel(proposal: AiReviewProposal, messages: EditorMessages["aiReview"]) {
  const mode = proposal.appliedMode ?? proposal.defaultApplyMode;
  return mode === "insert_below" ? messages.insertedText : messages.with;
}
