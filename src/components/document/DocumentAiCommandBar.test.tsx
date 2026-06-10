import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentAiCommandBar } from "./DocumentAiCommandBar";

describe("DocumentAiCommandBar", () => {
  it("explains why the command input is disabled when there is no target", () => {
    render(
      <DocumentAiCommandBar
        disabled
        language="ko"
        onSubmit={() => undefined}
        scope="document"
      />,
    );

    expect(screen.getByRole("combobox", { name: "AI 명령" })).toHaveAttribute(
      "placeholder",
      "먼저 문서 내용을 작성하거나 텍스트를 선택하세요.",
    );
  });

  it("submits a stable command string from a Korean selection preset", async () => {
    const user = userEvent.setup();
    const handleSubmit = vi.fn();

    render(
      <DocumentAiCommandBar
        availableScopes={["selection", "currentBlock", "document"]}
        language="ko"
        onSubmit={handleSubmit}
        scope="selection"
      />,
    );

    await user.click(screen.getByRole("button", { name: "빠른 명령 실행: Translate to Korean" }));

    expect(handleSubmit).toHaveBeenCalledWith("Translate to Korean");
  });

  it("shows scope-specific quick actions for the current block", () => {
    render(
      <DocumentAiCommandBar
        availableScopes={["currentBlock", "document"]}
        language="ko"
        onSubmit={() => undefined}
        scope="currentBlock"
      />,
    );

    expect(screen.getByRole("button", { name: "빠른 명령 실행: Strengthen evidence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "빠른 명령 실행: Continue writing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "빠른 명령 실행: Translate to Korean" })).not.toBeInTheDocument();
  });

  it("hides quick actions when the command bar has no valid target", () => {
    render(
      <DocumentAiCommandBar
        disabled
        language="ko"
        onSubmit={() => undefined}
        scope="document"
      />,
    );

    expect(screen.queryByRole("button", { name: /빠른 명령 실행:/ })).not.toBeInTheDocument();
  });

  it("resolves document mention references when submitting a freeform command", async () => {
    const user = userEvent.setup();
    const handleSubmit = vi.fn();

    render(
      <DocumentAiCommandBar
        language="ko"
        onSubmit={handleSubmit}
        referenceCandidates={[
          {
            id: "doc_ref",
            plainText: "Reference body",
            title: "Revenue Memo",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
        scope="document"
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "AI 명령" }), "Compare @Revenue");
    await user.click(screen.getByRole("option", { name: "Revenue Memo" }));
    await user.click(screen.getByRole("button", { name: "AI 요청" }));

    expect(handleSubmit).toHaveBeenCalledWith("Compare @Revenue Memo", [{ id: "doc_ref", title: "Revenue Memo" }]);
  });

  it("keeps the selected duplicate-title document id", async () => {
    const user = userEvent.setup();
    const handleSubmit = vi.fn();

    render(
      <DocumentAiCommandBar
        language="ko"
        onSubmit={handleSubmit}
        referenceCandidates={[
          { id: "doc_first", plainText: "First body", title: "Revenue Memo" },
          { id: "doc_second", plainText: "Second body", title: "Revenue Memo" },
        ]}
        scope="document"
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "AI 명령" }), "Compare @Revenue");
    await user.click(screen.getByRole("option", { name: "Revenue Memo (doc_second)" }));
    await user.click(screen.getByRole("button", { name: "AI 요청" }));

    expect(handleSubmit).toHaveBeenCalledWith("Compare @Revenue Memo", [
      { id: "doc_second", title: "Revenue Memo" },
    ]);
  });
});
