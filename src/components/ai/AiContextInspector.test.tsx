import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiContextInspector } from "./AiContextInspector";
import type { AiContextSnapshot } from "@/features/ai/ai-context-snapshot";

const messages = {
  charCount: "{count} 글자",
  command: "명령",
  copied: "복사됨",
  copy: "컨텍스트 복사",
  document: "문서",
  empty: "표시할 AI 컨텍스트가 없습니다.",
  model: "모델",
  selection: "선택 영역",
  template: "템플릿",
  title: "AI 컨텍스트",
  variables: "변수",
};

const snapshot: AiContextSnapshot = {
  ai: { model: "gpt-5-nano", provider: "coredot" },
  command: "Translate to English",
  document: {
    charCount: 6,
    id: "doc_1",
    text: "본문",
    title: "계약서",
  },
  mode: "selection_rewrite",
  schemaVersion: 1,
  selection: {
    charCount: 5,
    text: "선택문",
  },
  template: {
    category: "contract",
    id: "tpl_1",
    name: "Contract Review",
  },
  variables: {
    names: ["contractType"],
    values: { contractType: "MSA" },
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AiContextInspector", () => {
  it("renders a readable context summary", () => {
    render(<AiContextInspector messages={messages} snapshot={snapshot} />);

    expect(screen.getByRole("region", { name: "AI 컨텍스트" })).toHaveTextContent("Translate to English");
    expect(screen.getByText("coredot / gpt-5-nano")).toBeInTheDocument();
    expect(screen.getByText("Contract Review")).toBeInTheDocument();
    expect(screen.getByText("contractType")).toBeInTheDocument();
    expect(screen.getByText("계약서 · 6 글자")).toBeInTheDocument();
  });

  it("copies the snapshot JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<AiContextInspector messages={messages} snapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "컨텍스트 복사" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Translate to English")));
    expect(screen.getByText("복사됨")).toBeInTheDocument();
  });

  it("renders an empty state", () => {
    render(<AiContextInspector messages={messages} snapshot={null} />);

    expect(screen.getByText("표시할 AI 컨텍스트가 없습니다.")).toBeInTheDocument();
  });
});
