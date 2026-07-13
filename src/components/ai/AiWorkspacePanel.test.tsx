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
});
