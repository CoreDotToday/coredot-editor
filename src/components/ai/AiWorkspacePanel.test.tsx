import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { editorMessages } from "@/features/i18n/editor-language";
import { AiWorkspacePanel, type AiWorkspaceChatSession } from "./AiWorkspacePanel";

const session: AiWorkspaceChatSession = {
  command: "Improve clarity",
  createdAt: new Date("2026-06-08T01:00:00.000Z"),
  id: "session_1",
  messages: [{ content: "원문", id: "message_1", role: "user" }],
  status: "idle",
  syncStatus: "saved",
  title: "명확하게 개선",
  updatedAt: new Date("2026-06-08T01:00:01.000Z"),
};

describe("AiWorkspacePanel", () => {
  it("renames the active chat session inline", () => {
    const onRenameChatSession = vi.fn();

    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        chatSessions={[session]}
        errorMessage=""
        isReviewing={false}
        language="ko"
        messages={editorMessages.ko.aiWorkspace}
        onRenameChatSession={onRenameChatSession}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        reviewMessages={editorMessages.ko.aiReview}
        selectedTemplateName="Contract Review"
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "대화" }));
    fireEvent.click(screen.getByRole("button", { name: "대화 이름 변경" }));
    fireEvent.change(screen.getByRole("textbox", { name: "대화 제목" }), { target: { value: "번역 결과" } });
    fireEvent.click(screen.getByRole("button", { name: "이름 저장" }));

    expect(onRenameChatSession).toHaveBeenCalledWith("session_1", "번역 결과");
  });

  it("requests persisted history when the Changes tab opens", () => {
    const onChangesOpen = vi.fn();

    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        errorMessage=""
        isReviewing={false}
        messages={editorMessages.ko.aiWorkspace}
        onChangesOpen={onChangesOpen}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "변경내역" }));

    expect(onChangesOpen).toHaveBeenCalledTimes(1);
  });

  it("shows English change-history loading and retry states", () => {
    const onLoadMoreChanges = vi.fn();
    render(
      <AiWorkspacePanel
        changeItems={[]}
        changeLoadErrorMessage="Could not load change history. Try again."
        chatMessages={[]}
        errorMessage=""
        hasMoreChanges
        isLoadingChanges
        isReviewing={false}
        language="en"
        messages={editorMessages.en.aiWorkspace}
        onLoadMoreChanges={onLoadMoreChanges}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load change history. Try again.");
    expect(screen.getByRole("button", { name: "Loading changes..." })).toBeDisabled();
  });

  it("loads more change history with the Korean label", () => {
    const onLoadMoreChanges = vi.fn();
    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        errorMessage=""
        hasMoreChanges
        isReviewing={false}
        messages={editorMessages.ko.aiWorkspace}
        onLoadMoreChanges={onLoadMoreChanges}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "변경내역" }));
    fireEvent.click(screen.getByRole("button", { name: "더 불러오기" }));
    expect(onLoadMoreChanges).toHaveBeenCalledTimes(1);
  });

  it("shows execution and persistence status separately and blocks fork until saved", () => {
    const onForkChatSession = vi.fn();
    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        chatSessions={[{ ...session, status: "running", syncStatus: "saving" }]}
        errorMessage=""
        isReviewing={false}
        messages={editorMessages.ko.aiWorkspace}
        onForkChatSession={onForkChatSession}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "대화" }));
    expect(screen.getByText(/AI 실행 중/)).toBeInTheDocument();
    expect(screen.getByText(/저장 중/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "대화 분기" })).not.toBeInTheDocument();
    expect(onForkChatSession).not.toHaveBeenCalled();
  });

  it("forks a saved conversation from its latest durable message", () => {
    const onForkChatSession = vi.fn();
    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        chatSessions={[session]}
        errorMessage=""
        isReviewing={false}
        messages={editorMessages.ko.aiWorkspace}
        onForkChatSession={onForkChatSession}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "대화" }));
    fireEvent.click(screen.getByRole("button", { name: "대화 분기" }));
    expect(onForkChatSession).toHaveBeenCalledWith("session_1", "message_1");
  });

  it("exposes conversation load failures with an explicit retry", () => {
    const onRetryConversation = vi.fn();
    render(
      <AiWorkspacePanel
        changeItems={[]}
        chatMessages={[]}
        conversationErrorMessage="대화를 불러오지 못했습니다."
        conversationLoadState="failed"
        errorMessage=""
        isReviewing={false}
        messages={editorMessages.ko.aiWorkspace}
        onRetryConversation={onRetryConversation}
        onReviewDocument={vi.fn()}
        onUndoChange={vi.fn()}
        onUpdateProposalStatus={vi.fn()}
        proposals={[]}
        selectedTemplateName=""
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "대화" }));
    expect(screen.getByRole("alert")).toHaveTextContent("대화를 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryConversation).toHaveBeenCalledTimes(1);
  });
});
