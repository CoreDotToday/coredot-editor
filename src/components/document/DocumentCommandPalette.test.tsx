import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentCommandPalette } from "./DocumentCommandPalette";
import type { DocumentCommandAction } from "./commands/document-command-types";

const messages = {
  empty: "일치하는 명령이 없습니다.",
  footerHint: "Enter로 실행 · Esc로 닫기",
  groups: {
    ai: "AI",
    document: "문서",
    export: "내보내기",
    view: "보기",
  },
  placeholder: "명령 검색...",
  searchLabel: "명령 검색",
  title: "명령 팔레트",
};

function createActions(overrides: Partial<DocumentCommandAction>[] = []): DocumentCommandAction[] {
  const baseActions: DocumentCommandAction[] = [
    {
      enabled: true,
      execute: vi.fn(),
      group: "ai",
      id: "review-document",
      keywords: ["review", "검토"],
      label: "문서 검토",
      shortcut: "R",
    },
    {
      enabled: true,
      execute: vi.fn(),
      group: "view",
      id: "show-source",
      keywords: ["source", "raw", "json"],
      label: "Source 보기",
    },
    {
      enabled: false,
      execute: vi.fn(),
      group: "document",
      id: "save-document",
      keywords: ["save", "저장"],
      label: "문서 저장",
    },
  ];

  return baseActions.map((action, index) => ({ ...action, ...overrides[index] }));
}

describe("DocumentCommandPalette", () => {
  it("renders grouped enabled commands and hides disabled commands", () => {
    render(<DocumentCommandPalette actions={createActions()} messages={messages} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "보기" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /문서 검토/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Source 보기/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /문서 저장/ })).not.toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("filters commands by fuzzy label and keyword matches", async () => {
    const user = userEvent.setup();
    render(<DocumentCommandPalette actions={createActions()} messages={messages} onClose={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "명령 검색" });
    await user.type(input, "rvw");

    expect(screen.getByRole("option", { name: /문서 검토/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Source 보기/ })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "json");

    expect(screen.getByRole("option", { name: /Source 보기/ })).toBeInTheDocument();
  });

  it("runs the selected command with keyboard navigation and closes", async () => {
    const user = userEvent.setup();
    const actions = createActions();
    const onClose = vi.fn();

    render(<DocumentCommandPalette actions={actions} messages={messages} onClose={onClose} />);

    const input = screen.getByRole("textbox", { name: "명령 검색" });
    await user.keyboard("{ArrowDown}{Enter}");

    expect(actions[1].execute).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: /Source 보기/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(input).toHaveFocus();
  });

  it("connects keyboard selection to the active descendant and closes from option focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DocumentCommandPalette actions={createActions()} messages={messages} onClose={onClose} />);

    const input = screen.getByRole("textbox", { name: "명령 검색" });
    const sourceOption = screen.getByRole("option", { name: /Source 보기/ });

    await user.keyboard("{ArrowDown}");

    expect(input).toHaveAttribute("aria-activedescendant", sourceOption.id);

    sourceOption.focus();
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and shows an empty state", () => {
    const onClose = vi.fn();
    render(<DocumentCommandPalette actions={createActions()} messages={messages} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox", { name: "명령 검색" }), { target: { value: "없는 명령" } });
    expect(screen.getByText("일치하는 명령이 없습니다.")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "명령 검색" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
