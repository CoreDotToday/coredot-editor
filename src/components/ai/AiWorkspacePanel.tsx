"use client";

import { Clock3, Loader2, MessageSquareText, RotateCcw, ScrollText, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState, type KeyboardEvent } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  getSelectionCommandLabel,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import { AiReviewPanel, type AiProposalApplyMode, type AiReviewProposal, type AiReviewSummary } from "./AiReviewPanel";

export type AiWorkspaceChatMessage = {
  command?: string;
  content: string;
  id: string;
  role: "user" | "assistant";
  scopeLabel?: string;
};

export type AiWorkspaceChangeItem = {
  appliedAt: Date;
  appliedMode: AiProposalApplyMode;
  canUndo: boolean;
  id: string;
  replacementText: string;
  targetText: string;
};

export type AiWorkspaceChatSession = {
  command: string;
  createdAt: Date;
  id: string;
  messages: AiWorkspaceChatMessage[];
  title: string;
  updatedAt: Date;
};

type AiWorkspacePanelProps = {
  activeProposalId?: string | null;
  changeItems: AiWorkspaceChangeItem[];
  children?: ReactNode;
  chatMessages: AiWorkspaceChatMessage[];
  chatSessions?: AiWorkspaceChatSession[];
  errorMessage: string;
  isReviewing: boolean;
  isRunningCommand?: boolean;
  language?: EditorLanguage;
  layout?: "drawer" | "side";
  messages?: EditorMessages["aiWorkspace"];
  onBulkUpdateProposalStatus?: (status: "accepted" | "rejected") => void;
  onClose?: () => void;
  onFocusProposal?: (proposalId: string) => void;
  onReviewDocument: () => void;
  onUndoChange: (changeId: string) => void;
  onUpdateProposalStatus: (
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode?: AiProposalApplyMode,
  ) => void;
  proposals: AiReviewProposal[];
  reviewMessages?: EditorMessages["aiReview"];
  reviewSummary?: AiReviewSummary | null;
  selectedTemplateName: string;
  undoErrorMessage?: string;
};

type WorkspaceTab = "review" | "chat" | "changes";

const tabs = [
  { icon: ScrollText, id: "review" },
  { icon: MessageSquareText, id: "chat" },
  { icon: Clock3, id: "changes" },
] as const;

export function AiWorkspacePanel({
  activeProposalId = null,
  changeItems,
  children,
  chatMessages,
  chatSessions = [],
  errorMessage,
  isReviewing,
  isRunningCommand = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  layout = "side",
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiWorkspace,
  onBulkUpdateProposalStatus,
  onClose,
  onFocusProposal,
  onReviewDocument,
  onUndoChange,
  onUpdateProposalStatus,
  proposals,
  reviewMessages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiReview,
  reviewSummary = null,
  selectedTemplateName,
  undoErrorMessage = "",
}: AiWorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("review");
  const [activeChatSessionId, setActiveChatSessionId] = useState<string>("");
  const workspaceId = useId();
  const activeChatSession = chatSessions.find((session) => session.id === activeChatSessionId) ?? chatSessions[0] ?? null;
  const activeChatMessages = activeChatSession?.messages ?? chatMessages;
  const panelClassName =
    layout === "drawer"
      ? "flex h-full w-[min(100vw,24rem)] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-2xl shadow-zinc-950/20"
      : "hidden w-[23rem] shrink-0 flex-col border-l border-zinc-200 bg-white xl:flex";

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (tabIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex]?.id ?? "review";
    setActiveTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`${workspaceId}-${nextTab}-tab`)?.focus();
    });
  };

  return (
    <aside aria-label={messages.tabList} className={panelClassName}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <div
          aria-label={messages.tabList}
          className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-md bg-zinc-100 p-1"
          role="tablist"
        >
          {tabs.map(({ icon: Icon, id }) => (
            <button
              aria-controls={`${workspaceId}-${id}-panel`}
              aria-selected={activeTab === id}
              className={[
                "inline-flex h-8 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors",
                activeTab === id ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950",
              ].join(" ")}
              id={`${workspaceId}-${id}-tab`}
              key={id}
              onClick={() => setActiveTab(id)}
              onKeyDown={(event) => handleTabKeyDown(event, tabs.findIndex((tab) => tab.id === id))}
              role="tab"
              tabIndex={activeTab === id ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {messages.tabs[id]}
            </button>
          ))}
        </div>
        {onClose ? (
          <button
            aria-label={messages.close}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>

      {isRunningCommand ? (
        <div
          aria-label={messages.runningStatusLabel}
          className="border-b border-zinc-200 bg-zinc-50 px-4 py-3"
          role="status"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <Loader2 aria-hidden="true" className="size-4 animate-spin text-zinc-500" />
            <span>{messages.running}</span>
          </div>
        </div>
      ) : null}

      {activeTab === "review" ? (
        <AiReviewPanel
          ariaLabelledBy={`${workspaceId}-review-tab`}
          activeProposalId={activeProposalId}
          errorMessage={errorMessage}
          id={`${workspaceId}-review-panel`}
          isReviewing={isReviewing}
          messages={reviewMessages}
          onBulkUpdateProposalStatus={onBulkUpdateProposalStatus}
          onFocusProposal={onFocusProposal}
          onReviewDocument={onReviewDocument}
          onUpdateProposalStatus={onUpdateProposalStatus}
          proposals={proposals}
          reviewSummary={reviewSummary}
          selectedTemplateName={selectedTemplateName}
        />
      ) : null}

      {activeTab === "chat" ? (
        <section
          aria-labelledby={`${workspaceId}-chat-tab`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
          id={`${workspaceId}-chat-panel`}
          role="tabpanel"
        >
          <h2 className="text-sm font-semibold text-zinc-950">{messages.chatTitle}</h2>
          {chatSessions.length > 0 ? (
            <div
              aria-label={messages.conversationList}
              className="mt-4 flex gap-2 overflow-x-auto pb-1"
              role="tablist"
            >
              {chatSessions.map((session) => (
                <button
                  aria-controls={`${workspaceId}-chat-session-${session.id}`}
                  aria-selected={activeChatSession?.id === session.id}
                  className={[
                    "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                    activeChatSession?.id === session.id
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950",
                  ].join(" ")}
                  id={`${workspaceId}-chat-session-${session.id}-tab`}
                  key={session.id}
                  onClick={() => setActiveChatSessionId(session.id)}
                  role="tab"
                  type="button"
                >
                  {session.title}
                </button>
              ))}
            </div>
          ) : null}
          {activeChatMessages.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-zinc-500">{messages.chatEmpty}</p>
          ) : (
            <ul
              aria-labelledby={
                activeChatSession ? `${workspaceId}-chat-session-${activeChatSession.id}-tab` : undefined
              }
              className="mt-4 space-y-4"
              id={activeChatSession ? `${workspaceId}-chat-session-${activeChatSession.id}` : undefined}
              role={activeChatSession ? "tabpanel" : undefined}
            >
              {activeChatMessages.map((message) => (
                <li key={message.id}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
                      {message.role === "user" ? messages.user : messages.assistant}
                    </span>
                    {message.scopeLabel ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
                        {message.scopeLabel}
                      </span>
                    ) : null}
                  </div>
                  {message.command ? (
                    <p className="mt-1 text-sm font-medium text-zinc-950">
                      {getSelectionCommandLabel(message.command, language)}
                    </p>
                  ) : null}
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{message.content}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {activeTab === "changes" ? (
        <section
          aria-labelledby={`${workspaceId}-changes-tab`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
          id={`${workspaceId}-changes-panel`}
          role="tabpanel"
        >
          <h2 className="text-sm font-semibold text-zinc-950">{messages.changeTitle}</h2>
          {undoErrorMessage ? (
            <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              {undoErrorMessage}
            </p>
          ) : null}
          {changeItems.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-zinc-500">{messages.changeEmpty}</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {changeItems.map((item) => (
                <li className="border-t border-zinc-200 pt-4" key={item.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">
                      {formatEditorMessage(messages.appliedAt, { time: formatChangeTime(item.appliedAt, language) })}
                    </p>
                    <button
                      aria-label={formatEditorMessage(messages.undoChange, { targetText: item.targetText })}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
                      disabled={!item.canUndo}
                      onClick={() => onUndoChange(item.id)}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="size-3.5" />
                      {messages.undo}
                    </button>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-700">{item.targetText}</p>
                  <p className="mt-1 line-clamp-3 text-sm leading-6 text-zinc-950">{item.replacementText}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {children}
    </aside>
  );
}

function formatChangeTime(date: Date, language: EditorLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
