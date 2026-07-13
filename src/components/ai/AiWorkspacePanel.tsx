"use client";

import { Check, Clock3, GitFork, Loader2, MessageSquareText, Pencil, Puzzle, RotateCcw, ScrollText, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useState, type KeyboardEvent } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  getSelectionCommandLabel,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import { PluginRenderedContribution } from "@/plugins/PluginRenderedContribution";
import type { EditorWorkspaceHostContext, EditorWorkspacePanel } from "@/plugins/types";
import { AiReviewPanel, type AiProposalApplyMode, type AiReviewProposal, type AiReviewSummary } from "./AiReviewPanel";

export type AiWorkspaceChatMessage = {
  command?: string;
  content: string;
  createdAt?: Date | string;
  id: string;
  proposalId?: string;
  role: "user" | "assistant";
  runId?: string;
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
  archived?: boolean;
  command: string;
  createdAt: Date;
  id: string;
  messages: AiWorkspaceChatMessage[];
  status?: "failed" | "idle" | "running";
  syncStatus?: "saved" | "saving" | "unsaved";
  title: string;
  transcriptState?: "failed" | "idle" | "loaded" | "loading";
  updatedAt: Date;
};

type AiWorkspacePanelProps = {
  activeProposalId?: string | null;
  changeItems: AiWorkspaceChangeItem[];
  changeLoadErrorMessage?: string;
  children?: ReactNode;
  chatMessages: AiWorkspaceChatMessage[];
  chatSessions?: AiWorkspaceChatSession[];
  conversationErrorMessage?: string;
  conversationLoadState?: "failed" | "loaded" | "loading";
  errorMessage: string;
  isReviewing: boolean;
  hasMoreChanges?: boolean;
  hasMoreConversations?: boolean;
  isLoadingChanges?: boolean;
  isLoadingMoreConversations?: boolean;
  isRunningCommand?: boolean;
  language?: EditorLanguage;
  layout?: "drawer" | "side";
  messages?: EditorMessages["aiWorkspace"];
  onArchiveChatSession?: (sessionId: string) => void;
  onBulkUpdateProposalStatus?: (status: "accepted" | "rejected") => void;
  onChangesOpen?: () => void;
  onClose?: () => void;
  onFocusProposal?: (proposalId: string) => void;
  onLoadMoreProposals?: () => void;
  onLoadProposalDetail?: (proposalId: string) => void;
  hasMoreProposals?: boolean;
  isLoadingMoreProposals?: boolean;
  onForkChatSession?: (sessionId: string, messageId: string) => void;
  onLoadMoreChanges?: () => void;
  onLoadMoreConversations?: () => void;
  onReviewDocument: () => void;
  onRenameChatSession?: (sessionId: string, title: string) => void;
  onRetryConversation?: () => void;
  onRetryChatSession?: (sessionId: string) => void;
  onSelectChatSession?: (sessionId: string) => void;
  onUndoChange: (changeId: string) => void;
  onUpdateProposalStatus: (
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode?: AiProposalApplyMode,
  ) => void;
  proposals: AiReviewProposal[];
  pluginContext?: EditorWorkspaceHostContext;
  pluginPanels?: EditorWorkspacePanel[];
  reviewMessages?: EditorMessages["aiReview"];
  reviewSummary?: AiReviewSummary | null;
  selectedTemplateName: string;
  undoErrorMessage?: string;
};

type WorkspaceTab = string;

const coreTabs = [
  { icon: ScrollText, id: "review" },
  { icon: MessageSquareText, id: "chat" },
  { icon: Clock3, id: "changes" },
] as const;

export function AiWorkspacePanel({
  activeProposalId = null,
  changeItems,
  changeLoadErrorMessage = "",
  children,
  chatMessages,
  chatSessions = [],
  conversationErrorMessage = "",
  conversationLoadState = "loaded",
  errorMessage,
  hasMoreChanges = false,
  hasMoreConversations = false,
  isReviewing,
  isLoadingChanges = false,
  isLoadingMoreConversations = false,
  isRunningCommand = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  layout = "side",
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiWorkspace,
  onArchiveChatSession,
  onBulkUpdateProposalStatus,
  onChangesOpen,
  onClose,
  onFocusProposal,
  onLoadMoreProposals,
  onLoadProposalDetail,
  hasMoreProposals = false,
  isLoadingMoreProposals = false,
  onForkChatSession,
  onLoadMoreChanges,
  onLoadMoreConversations,
  onReviewDocument,
  onRenameChatSession,
  onRetryConversation,
  onRetryChatSession,
  onSelectChatSession,
  onUndoChange,
  onUpdateProposalStatus,
  pluginContext,
  pluginPanels = [],
  proposals,
  reviewMessages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiReview,
  reviewSummary = null,
  selectedTemplateName,
  undoErrorMessage = "",
}: AiWorkspacePanelProps) {
  const [selectedTab, setSelectedTab] = useState<WorkspaceTab>("review");
  const [activeChatSessionId, setActiveChatSessionId] = useState<string>("");
  const [renamingChatSessionId, setRenamingChatSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const workspaceId = useId();
  const tabs = [
    ...coreTabs.map((tab) => ({ ...tab, label: messages.tabs[tab.id] })),
    ...pluginPanels.map((panel) => ({ icon: Puzzle, id: getPluginWorkspaceTabId(panel.id), label: panel.label })),
  ];
  const activeTab = tabs.some((tab) => tab.id === selectedTab) ? selectedTab : "review";
  const visibleChatSessions = chatSessions.filter((session) => !session.archived);
  const activeChatSession =
    visibleChatSessions.find((session) => session.id === activeChatSessionId) ?? visibleChatSessions[0] ?? null;
  const activeChatMessages = activeChatSession ? activeChatSession.messages : chatSessions.length > 0 ? [] : chatMessages;
  const isRenamingActiveChat = activeChatSession?.id === renamingChatSessionId;

  useEffect(() => {
    if (activeChatSession?.id) onSelectChatSession?.(activeChatSession.id);
  }, [activeChatSession?.id, onSelectChatSession]);
  const panelClassName =
    layout === "drawer"
      ? "flex h-full w-[min(100vw,24rem)] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-2xl shadow-zinc-950/20"
      : "hidden w-[23rem] shrink-0 flex-col border-l border-zinc-200 bg-white xl:flex";

  const activateTab = (nextTab: WorkspaceTab) => {
    setSelectedTab(nextTab);
    if (nextTab === "changes") onChangesOpen?.();
  };

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
    activateTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`${workspaceId}-${nextTab}-tab`)?.focus();
    });
  };

  return (
    <aside aria-label={messages.tabList} className={panelClassName}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <div
          aria-label={messages.tabList}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-md bg-zinc-100 p-1"
          role="tablist"
        >
          {tabs.map(({ icon: Icon, id }) => (
            <button
              aria-controls={`${workspaceId}-${id}-panel`}
              aria-selected={activeTab === id}
              className={[
                "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors",
                activeTab === id ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950",
              ].join(" ")}
              id={`${workspaceId}-${id}-tab`}
              key={id}
              onClick={() => activateTab(id)}
              onKeyDown={(event) => handleTabKeyDown(event, tabs.findIndex((tab) => tab.id === id))}
              role="tab"
              tabIndex={activeTab === id ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {tabs.find((tab) => tab.id === id)?.label}
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
          onLoadMore={onLoadMoreProposals}
          onLoadProposalDetail={onLoadProposalDetail}
          hasMore={hasMoreProposals}
          isLoadingMore={isLoadingMoreProposals}
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
          {conversationLoadState === "loading" ? (
            <p className="mt-3 text-sm text-zinc-500" role="status">{messages.conversationLoading}</p>
          ) : null}
          {conversationLoadState === "failed" || conversationErrorMessage ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              <p>{conversationErrorMessage || messages.conversationLoadFailed}</p>
              {onRetryConversation ? (
                <button
                  className="mt-2 font-semibold underline underline-offset-2"
                  onClick={onRetryConversation}
                  type="button"
                >
                  {messages.conversationRetry}
                </button>
              ) : null}
            </div>
          ) : null}
          {visibleChatSessions.length > 0 ? (
            <div
              aria-label={messages.conversationList}
              className="mt-4 flex gap-2 overflow-x-auto pb-1"
              role="tablist"
            >
              {visibleChatSessions.map((session) => (
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
          {hasMoreConversations && onLoadMoreConversations ? (
            <button
              className="mt-3 inline-flex h-8 w-full items-center justify-center rounded-md border border-zinc-300 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
              disabled={isLoadingMoreConversations}
              onClick={onLoadMoreConversations}
              type="button"
            >
              {isLoadingMoreConversations ? messages.conversationLoading : messages.conversationLoadMore}
            </button>
          ) : null}
          {activeChatSession?.transcriptState === "loading" ? (
            <p className="mt-3 text-sm text-zinc-500" role="status">{messages.conversationLoading}</p>
          ) : null}
          {activeChatSession?.transcriptState === "failed" ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              <p>{messages.conversationLoadFailed}</p>
              {onRetryChatSession ? (
                <button
                  className="mt-2 font-semibold underline underline-offset-2"
                  onClick={() => onRetryChatSession(activeChatSession.id)}
                  type="button"
                >
                  {messages.conversationRetry}
                </button>
              ) : null}
            </div>
          ) : null}
          {activeChatSession && (onArchiveChatSession || onForkChatSession || onRenameChatSession) ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-xs text-zinc-500">
                  {activeChatSession.status === "failed"
                    ? messages.failed
                    : activeChatSession.status === "running"
                      ? messages.executionRunning
                      : messages.executionIdle}
                  {" · "}
                  {activeChatSession.syncStatus === "saving"
                    ? messages.savingConversation
                    : activeChatSession.syncStatus === "unsaved"
                      ? messages.unsavedConversation
                      : messages.saved}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  {onRenameChatSession ? (
                    <button
                      aria-label={messages.renameChat}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                      onClick={() => {
                        setRenamingChatSessionId(activeChatSession.id);
                        setRenameDraft(activeChatSession.title);
                      }}
                      type="button"
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                      {messages.renameChat}
                    </button>
                  ) : null}
                  {onArchiveChatSession ? (
                    <button
                      className="inline-flex h-7 items-center rounded-md border border-zinc-200 px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                      onClick={() => onArchiveChatSession(activeChatSession.id)}
                      type="button"
                    >
                      {messages.archiveChat}
                    </button>
                  ) : null}
                  {onForkChatSession &&
                  activeChatSession.syncStatus === "saved" &&
                  activeChatSession.messages.at(-1) ? (
                    <button
                      aria-label={messages.forkChat}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                      onClick={() => onForkChatSession(activeChatSession.id, activeChatSession.messages.at(-1)!.id)}
                      type="button"
                    >
                      <GitFork aria-hidden="true" className="size-3.5" />
                      {messages.forkChat}
                    </button>
                  ) : null}
                </div>
              </div>
              {isRenamingActiveChat && onRenameChatSession ? (
                <div className="flex items-center gap-1">
                  <label className="sr-only" htmlFor={`${workspaceId}-rename-chat`}>
                    {messages.renameInput}
                  </label>
                  <input
                    aria-label={messages.renameInput}
                    className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
                    id={`${workspaceId}-rename-chat`}
                    onChange={(event) => setRenameDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        onRenameChatSession(activeChatSession.id, renameDraft);
                        setRenamingChatSessionId(null);
                      }
                      if (event.key === "Escape") {
                        setRenamingChatSessionId(null);
                      }
                    }}
                    value={renameDraft}
                  />
                  <button
                    aria-label={messages.saveRename}
                    className="inline-flex size-8 items-center justify-center rounded-md bg-zinc-950 text-white hover:bg-zinc-800"
                    onClick={() => {
                      onRenameChatSession(activeChatSession.id, renameDraft);
                      setRenamingChatSessionId(null);
                    }}
                    type="button"
                  >
                    <Check aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    aria-label={messages.cancelRename}
                    className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                    onClick={() => setRenamingChatSessionId(null)}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {activeChatMessages.length === 0 && activeChatSession?.transcriptState !== "loading" && activeChatSession?.transcriptState !== "failed" ? (
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
          {changeLoadErrorMessage ? (
            <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              {changeLoadErrorMessage}
            </p>
          ) : null}
          {changeItems.length === 0 && isLoadingChanges ? (
            <p className="mt-3 text-sm leading-6 text-zinc-500" role="status">{messages.changeLoading}</p>
          ) : changeItems.length === 0 ? (
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
          {hasMoreChanges && onLoadMoreChanges ? (
            <button
              className="mt-5 inline-flex h-9 w-full items-center justify-center rounded-md border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
              disabled={isLoadingChanges}
              onClick={onLoadMoreChanges}
              type="button"
            >
              {isLoadingChanges ? messages.changeLoading : messages.changeLoadMore}
            </button>
          ) : null}
        </section>
      ) : null}

      {pluginPanels.map((panel) => {
        const tabId = getPluginWorkspaceTabId(panel.id);
        if (activeTab !== tabId || !pluginContext) return null;

        return (
          <section
            aria-labelledby={`${workspaceId}-${tabId}-tab`}
            className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
            id={`${workspaceId}-${tabId}-panel`}
            key={panel.id}
            role="tabpanel"
          >
            <PluginWorkspacePanelContribution context={pluginContext} panel={panel} />
          </section>
        );
      })}

      {children}
    </aside>
  );
}

function PluginWorkspacePanelContribution({
  context,
  panel,
}: {
  context: EditorWorkspaceHostContext;
  panel: EditorWorkspacePanel;
}) {
  const render = useCallback(() => panel.render(context), [context, panel]);

  return (
    <PluginRenderedContribution
      contributionId={panel.id}
      contributionType="workspacePanel"
      render={render}
    />
  );
}

function getPluginWorkspaceTabId(panelId: string) {
  const characterCount = Array.from(panelId).length;
  const encodedId = Array.from(panelId, (character) => {
    return /^[A-Za-z0-9]$/.test(character) ? character : `_${character.codePointAt(0)?.toString(16)}_`;
  }).join("");
  return `plugin-${characterCount}-${encodedId || "empty"}`;
}

function formatChangeTime(date: Date, language: EditorLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
