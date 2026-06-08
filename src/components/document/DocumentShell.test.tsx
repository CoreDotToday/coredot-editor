import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentShell } from "./DocumentShell";
import { SelectionAiMenu } from "./SelectionAiMenu";

vi.mock("./DocumentEditor", () => ({
  DocumentEditor: ({
    contentJson,
    inlineSuggestions = [],
    isSelectionCommandLimitReached,
    isSelectionCommandRunning,
    onChange,
    onApplySelectionAiResult,
    onDismissSelectionAiResult,
    onSelectionCommand,
    runningSelectionCommand,
    runningSelectionCommands = [],
    selectionAiResult,
    language = "ko",
    messages = { titleLabel: "문서 제목" },
    title,
  }: {
    contentJson: { type: "doc"; content?: unknown[] };
    inlineSuggestions?: Array<{ active?: boolean; id: string; targetText: string }>;
    isSelectionCommandLimitReached?: boolean;
    isSelectionCommandRunning?: boolean;
    language?: "en" | "ko";
    messages?: { titleLabel: string };
    onChange: (draft: { title: string; contentJson: { type: "doc"; content?: unknown[] } }) => void;
    onApplySelectionAiResult?: (proposalId: string, applyMode: "replace" | "insert_below") => void;
    onDismissSelectionAiResult?: () => void;
    onSelectionCommand?: (
      command: string,
      selectedText: string,
      context?: {
        anchor: { left: number; side: "top" | "bottom"; top: number };
        occurrenceIndex: number;
        selectionRange?: { from: number; to: number };
      },
    ) => void;
    runningSelectionCommand?: string;
    runningSelectionCommands?: Array<{ command: string; id: string }>;
    selectionAiResult?: {
      command: string;
      defaultApplyMode: "replace" | "insert_below";
      proposalId: string;
      replacementText: string;
      targetText: string;
    } | null;
    title: string;
  }) => (
    <div>
      <input
        aria-label={messages.titleLabel}
        onChange={(event) => onChange({ title: event.currentTarget.value, contentJson })}
        value={title}
      />
      <div data-testid="mock-document-body">{readMockTiptapText(contentJson)}</div>
      <output data-testid="mock-inline-suggestions">{JSON.stringify(inlineSuggestions)}</output>
      {isSelectionCommandRunning ? (
        <div data-testid="mock-selection-command-running">
          {runningSelectionCommand} {runningSelectionCommands.length}
        </div>
      ) : null}
      {isSelectionCommandLimitReached ? <div data-testid="mock-selection-command-limit">limit reached</div> : null}
      <button onClick={() => onSelectionCommand?.("Improve clarity", "selected text")} type="button">
        Mock selection command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Translate to Korean", "selected text", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 0,
            selectionRange: { from: 1, to: 14 },
          })
        }
        type="button"
      >
        Mock translation command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Continue writing", "selected text", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 0,
            selectionRange: { from: 1, to: 14 },
          })
        }
        type="button"
      >
        Mock continue writing command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Improve clarity", "repeat", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 1,
            selectionRange: { from: 8, to: 14 },
          })
        }
        type="button"
      >
        Mock second occurrence command
      </button>
      <button
        onClick={() =>
          onChange({
            title,
            contentJson: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "fresh edited body" }] }],
            },
          })
        }
        type="button"
      >
        Mock body edit
      </button>
      {selectionAiResult ? (
        <div aria-label={language === "en" ? "선택 AI 결과" : "선택 AI 결과"} role="region">
          <p>{getMockSelectionCommandLabel(selectionAiResult.command, language)}</p>
          <p>{selectionAiResult.targetText}</p>
          <p>{selectionAiResult.replacementText}</p>
          <button
            onClick={() =>
              onApplySelectionAiResult?.(selectionAiResult.proposalId, selectionAiResult.defaultApplyMode)
            }
            type="button"
          >
            {getMockApplyModeLabel(selectionAiResult.defaultApplyMode, language)}
          </button>
          <button
            onClick={() =>
              onApplySelectionAiResult?.(
                selectionAiResult.proposalId,
                selectionAiResult.defaultApplyMode === "insert_below" ? "replace" : "insert_below",
              )
            }
            type="button"
          >
            {getMockApplyModeLabel(
              selectionAiResult.defaultApplyMode === "insert_below" ? "replace" : "insert_below",
              language,
            )}
          </button>
          <button onClick={onDismissSelectionAiResult} type="button">
            {language === "en" ? "Dismiss" : "닫기"}
          </button>
        </div>
      ) : null}
    </div>
  ),
}));

function getMockApplyModeLabel(applyMode: "replace" | "insert_below", language: "en" | "ko") {
  if (language === "en") {
    return applyMode === "insert_below" ? "Insert below" : "Replace";
  }

  return applyMode === "insert_below" ? "아래에 추가" : "교체";
}

function getMockSelectionCommandLabel(command: string, language: "en" | "ko") {
  if (language === "en") {
    return command;
  }

  const labels: Record<string, string> = {
    "Continue writing": "이어서 쓰기",
    "Improve clarity": "명확하게 개선",
    "Translate to Korean": "한국어로 번역",
  };

  return labels[command] ?? command;
}

function readMockTiptapText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  const typedNode = node as { text?: unknown; content?: unknown[] };
  const text = typeof typedNode.text === "string" ? typedNode.text : "";
  const childText = (typedNode.content ?? []).map((child) => readMockTiptapText(child)).join("");

  return `${text}${childText}`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function createDocument(id: string, title: string) {
  return {
    id,
    title,
    contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
    plainText: "",
  };
}

function createDocumentWithContent(id: string, title: string, paragraphText: string) {
  return {
    id,
    title,
    contentJson: {
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text: paragraphText }] }],
    },
    plainText: paragraphText,
  };
}

function createTemplate(id: string, name: string) {
  return {
    id,
    name,
    category: "review",
    variableSchemaJson: { fields: [], required: [] },
  };
}

function createRequiredTemplate() {
  return {
    id: "tpl_1",
    name: "Board review",
    category: "review",
    variableSchemaJson: {
      fields: [{ name: "audience", label: "Audience", type: "text" as const, required: true }],
      required: ["audience"],
    },
  };
}

function createStrategyTemplate() {
  return {
    id: "tpl_strategy",
    name: "Executive Rewrite",
    category: "executive_rewrite",
    variableSchemaJson: {
      fields: [
        { name: "audience", label: "Audience", type: "text" as const, required: true },
        { name: "objective", label: "Document objective", type: "textarea" as const, required: true },
        { name: "tone", label: "Tone", type: "select" as const, required: true, options: ["executive", "analytical"] },
      ],
      required: ["audience", "objective", "tone"],
    },
  };
}

function createContractTemplate() {
  return {
    id: "tpl_contract",
    name: "Contract Review",
    category: "contract_review",
    variableSchemaJson: {
      fields: [
        {
          name: "partyPerspective",
          label: "Party perspective",
          type: "select" as const,
          required: true,
          options: ["customer", "vendor", "mutual", "investor"],
        },
        {
          name: "contractType",
          label: "Contract type",
          type: "select" as const,
          required: true,
          options: ["MSA", "NDA", "SaaS Agreement"],
        },
        {
          name: "riskTolerance",
          label: "Risk tolerance",
          type: "select" as const,
          required: true,
          options: ["balanced", "conservative", "aggressive"],
        },
      ],
      required: ["partyPerspective", "contractType", "riskTolerance"],
    },
  };
}

function createProposal(
  id: string,
  status: "pending" | "accepted" | "rejected" = "pending",
  targetText = "growth was good",
) {
  return {
    id,
    targetText,
    replacementText: "revenue grew 8%",
    explanation: "Unclear metric: Specificity helps review.",
    source: "review" as const,
    command: null,
    occurrenceIndex: null,
    targetFrom: null,
    targetTo: null,
    defaultApplyMode: "replace" as const,
    appliedMode: null,
    status,
  };
}

function createAiRun(id: string) {
  return {
    id,
    commandType: "document_review" as const,
    status: "completed" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });

  return { promise, reject, resolve };
}

describe("DocumentShell", () => {
  it("renders three workspace regions", () => {
    render(
      <DocumentShell
        document={{
          id: "doc_1",
          title: "Market Entry Memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
          plainText: "",
        }}
        templates={[]}
        aiRuns={[]}
      />,
    );

    expect(screen.getByText("개요")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Market Entry Memo");
    expect(screen.getByRole("button", { name: "LLM 설정" })).toBeInTheDocument();
    expect(screen.getByText("AI 검토")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "검토" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "대화" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "변경내역" })).toBeInTheDocument();
  });

  it("defaults to Korean and persists English editor language", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByRole("combobox", { name: "언어" })).toHaveValue("ko");
    expect(screen.getByText("AI 검토")).toBeInTheDocument();
    expect(screen.getByText("개요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "문서 검토" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "언어" }), "en");

    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(screen.getByText("AI Review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New document" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(window.localStorage.getItem("coredot-editor-language")).toBe("en");
  });

  it("renders required template validation messages in the selected language", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Audience" }));
    await user.click(screen.getByRole("button", { name: "Review document" }));

    expect(screen.getByText("Audience is required.")).toBeInTheDocument();
  });

  it("loads the saved editor language preference", () => {
    window.localStorage.setItem("coredot-editor-language", "en");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByText("AI Review")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
  });

  it("renders contract review template variables through the Korean language pack", () => {
    window.localStorage.setItem("coredot-editor-language", "ko");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "body")}
        templates={[createContractTemplate()]}
      />,
    );

    expect(screen.getByLabelText("검토 관점")).toHaveValue("customer");
    expect(screen.getByLabelText("계약 유형")).toHaveValue("MSA");
    expect(screen.getByLabelText("위험 허용도")).toHaveValue("balanced");
  });

  it("keeps newer unsaved edits dirty when an older save resolves", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(titleInput);
    await user.type(titleInput, "Market Entry Memo v2");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.type(titleInput, " updated");

    await act(async () => {
      deferredSave.resolve(new Response(JSON.stringify({ document: createDocument("doc_1", "Market Entry Memo v2") })));
      await deferredSave.promise;
    });

    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
  });

  it("autosaves dirty drafts after a short debounce", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ document: createDocument("doc_1", "Market Entry Memo") })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/doc_1",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("fresh edited body"),
      }),
    );
  });

  it("blocks internal sidebar navigation while local edits are unsaved", () => {
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
    expect(fireEvent.click(screen.getByRole("link", { name: "문서" }))).toBe(false);
  });

  it("warns before unload while an autosave is still in flight", async () => {
    vi.useFakeTimers();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("exports the current unsaved draft as DOCX", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrl = vi.fn(() => "blob:docx");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/doc_1/export",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("fresh edited body"),
      }),
    );
    expect(createObjectUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:docx");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("resets the title textbox when rerendered with a different document", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited title");

    rerender(<DocumentShell aiRuns={[]} document={createDocument("doc_2", "Board Brief")} templates={[]} />);

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Board Brief");
  });

  it("accepts same-document prop updates while saved", () => {
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo Updated", "Updated body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Market Entry Memo Updated");
  });

  it("preserves local dirty edits during same-document prop updates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local dirty title");
  });

  it("preserves local edits during same-document prop updates while saving", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Saving local title");
    await user.click(screen.getByRole("button", { name: "저장" }));

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Saving local title");
  });

  it("preserves local edits during same-document prop updates after save failure", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Failed local title");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await act(async () => {
      deferredSave.reject(new Error("network"));
      await deferredSave.promise.catch(() => undefined);
    });

    expect(screen.getByText("저장 실패")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Failed local title");
  });

  it("reflects the last selection command in the AI panel", async () => {
    const user = userEvent.setup();

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    expect(screen.getByText("마지막 선택 명령: 명확하게 개선")).toBeInTheDocument();
    expect(screen.getByText("선택됨: selected text")).toBeInTheDocument();
  });

  it("keeps the AI context inspector pinned to the document snapshot captured when a selection command starts", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "original body")}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "컨텍스트 복사" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copiedSnapshot = JSON.parse(writeText.mock.calls.at(-1)?.[0] ?? "{}") as {
      document?: { text?: string };
    };
    expect(copiedSnapshot.document?.text).toBe("original body");
  });

  it("runs selection rewrite commands and adds the returned proposal", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/rewrite",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"selectedText":"selected text"'),
        }),
      );
    });
    await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(screen.getAllByText("selected text").length).toBeGreaterThan(0);
    expect(screen.getAllByText("revenue grew 8%").length).toBeGreaterThan(0);
  });

  it("records AI command conversation in the right chat tab", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("tab", { name: "대화" }));
    const chatPanel = screen.getByRole("tabpanel", { name: "대화" });

    expect(within(chatPanel).getByText("사용자")).toBeInTheDocument();
    expect(within(chatPanel).getAllByText("명확하게 개선").length).toBeGreaterThan(0);
    expect(within(chatPanel).getByText("AI")).toBeInTheDocument();
    expect(within(chatPanel).getByText("revenue grew 8%")).toBeInTheDocument();
  });

  it("opens a command palette and runs workspace commands", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "source body")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");

    const palette = screen.getByRole("dialog", { name: "명령 팔레트" });
    expect(within(palette).getByRole("textbox", { name: "명령 검색" })).toBeInTheDocument();
    expect(within(palette).getByRole("option", { name: /문서 검토/ })).toBeInTheDocument();

    await user.type(within(palette).getByRole("textbox", { name: "명령 검색" }), "source");
    await user.click(within(palette).getByRole("option", { name: /Source 보기/ }));

    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "문서 Source" })).toHaveTextContent("source body");
  });

  it("keeps AI command conversations in separate sessions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_clarity"),
            proposal: createProposal("proposal_clarity", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_translate"),
            proposal: {
              ...createProposal("proposal_translate", "pending", "selected text"),
              replacementText: "선택된 텍스트",
            },
          }),
        ),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("button", { name: "Mock translation command" }));
    await waitFor(() => expect(screen.getAllByText("선택된 텍스트").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("tab", { name: "대화" }));

    expect(screen.getByRole("tab", { name: "명확하게 개선" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "한국어로 번역" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "명확하게 개선" }));
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).not.toHaveTextContent("선택된 텍스트");

    await user.click(screen.getByRole("tab", { name: "한국어로 번역" }));
    expect(screen.getByRole("tabpanel", { name: "한국어로 번역" })).toHaveTextContent("선택된 텍스트");
  });

  it("restores document-scoped AI command conversations and can hide a session", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_translate"),
            proposal: {
              ...createProposal("proposal_translate", "pending", "selected text"),
              replacementText: "선택된 텍스트",
            },
          }),
        ),
      );

    const rendered = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    rendered.unmount();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "대화" }));
    expect(screen.getByRole("tab", { name: "명확하게 개선" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");

    await user.click(screen.getByRole("button", { name: "Mock translation command" }));
    await waitFor(() => expect(screen.getAllByText("선택된 텍스트").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("tab", { name: "명확하게 개선" }));
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).not.toHaveTextContent("선택된 텍스트");

    await user.click(screen.getByRole("button", { name: "대화 숨기기" }));
    expect(screen.queryByRole("tab", { name: "명확하게 개선" })).not.toBeInTheDocument();
    expect(screen.queryByText("revenue grew 8%")).not.toBeInTheDocument();
  });

  it("shows the current draft in source view and switches back to rich editing", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "Source 보기" }));

    const sourceRegion = screen.getByRole("region", { name: "문서 Source" });
    expect(sourceRegion).toHaveTextContent("fresh edited body");
    expect(sourceRegion).toHaveTextContent('"type": "doc"');

    await user.click(screen.getByRole("button", { name: "편집 보기" }));

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "문서 Source" })).not.toBeInTheDocument();
  });

  it("shows a selection rewrite result preview with a translate default insert action", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_rewrite"), status: "accepted" } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock translation command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByText("한국어로 번역")).toBeInTheDocument();
    expect(within(preview).getByText("revenue grew 8%")).toBeInTheDocument();

    await user.click(within(preview).getByRole("button", { name: "아래에 추가" }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/proposals/proposal_rewrite",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "insert_below" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("selected text");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("초안에 반영되었습니다. 변경 사항을 유지하려면 저장하세요.")).toBeInTheDocument();
  });

  it("shows a selection rewrite result preview with a continue-writing default insert action", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_continue"),
          proposal: {
            ...createProposal("proposal_continue", "pending", "selected text"),
            command: "Continue writing",
            defaultApplyMode: "insert_below",
            source: "selection",
          },
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock continue writing command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByText("이어서 쓰기")).toBeInTheDocument();
    expect(within(preview).getByRole("button", { name: "아래에 추가" })).toBeInTheDocument();
  });

  it("uses replace as the default action for rewrite-style selection results", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByRole("button", { name: "교체" })).toBeInTheDocument();
  });

  it("applies current-session selection proposals to the captured occurrence", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "repeat"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_rewrite"), status: "accepted" } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "repeat repeat")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock second occurrence command" }));
    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai/rewrite",
      expect.objectContaining({
        body: expect.stringContaining('"occurrenceIndex":1'),
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai/rewrite",
      expect.objectContaining({
        body: expect.stringContaining('"selectionRange":{"from":8,"to":14}'),
      }),
    );

    await user.click(within(preview).getByRole("button", { name: "교체" }));

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("repeat revenue grew 8%");
  });

  it("does not apply a current-session selection proposal after the draft content changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(within(preview).getByRole("button", { name: "교체" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("runs selection rewrite commands immediately with default template variables", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "대상 독자" })).toHaveValue("Executive stakeholders");
    expect(screen.getByRole("textbox", { name: "문서 목표" })).toHaveValue(
      "Improve the selected text while preserving the document's intent.",
    );
    expect(screen.getByRole("combobox", { name: "톤" })).toHaveValue("executive");

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/rewrite",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(
            '"variables":{"audience":"Executive stakeholders","objective":"Improve the selected text while preserving the document\'s intent.","tone":"executive"}',
          ),
        }),
      );
    });
    expect(screen.queryByText("선택 AI 실행 전에 필수 템플릿 필드를 입력하세요.")).not.toBeInTheDocument();
  });

  it("shows selection rewrite progress while the command is running", async () => {
    const user = userEvent.setup();
    const deferredRewrite = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredRewrite.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(screen.getByTestId("mock-selection-command-running")).toHaveTextContent("Improve clarity");
    });

    await act(async () => {
      deferredRewrite.resolve(new Response(JSON.stringify({ run: createAiRun("run_rewrite"), proposal: null })));
      await deferredRewrite.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mock-selection-command-running")).not.toBeInTheDocument();
    });
  });

  it("allows five concurrent selection rewrite commands and blocks the sixth", async () => {
    const user = userEvent.setup();
    const pendingRewrite = new Promise<Response>(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingRewrite);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    const commandButton = screen.getByRole("button", { name: "Mock selection command" });
    for (let count = 0; count < 6; count += 1) {
      await user.click(commandButton);
    }

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
    expect(screen.getByTestId("mock-selection-command-running")).toHaveTextContent("5");
    expect(screen.getByTestId("mock-selection-command-limit")).toBeInTheDocument();
    expect(screen.getByText("AI 요청은 동시에 최대 5개까지 실행할 수 있습니다. 하나가 완료된 뒤 다시 요청하세요.")).toBeInTheDocument();
  });

  it("runs a full 문서 검토 with current unsaved draft text", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: {
            id: "run_1",
            commandType: "document_review",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          review: { summary: "One finding.", findings: [] },
          proposals: [],
          skippedProposalCount: 0,
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "stale initial body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/review",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"documentText":"fresh edited body"'),
      }),
    );
  });

  it("shows review summary and skipped proposals after a document review", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          review: {
            summary: "세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.",
            findings: [
              {
                problem: "Unclear evidence",
                reason: "The source is missing.",
                targetText: "growth was good",
                replacementText: "revenue grew 8%",
              },
              {
                problem: "Duplicate target",
                reason: "The sentence appears twice.",
                targetText: "repeated",
                replacementText: "specific repeated text",
              },
              {
                problem: "Too broad",
                reason: "The target is too large.",
                targetText: "whole document",
                replacementText: "rewrite everything",
              },
            ],
          },
          proposals: [createProposal("proposal_1")],
          skippedProposalCount: 2,
        }),
      ),
    );
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good");
    const templates = [createTemplate("tpl_1", "Board review")];

    const { rerender } = render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토 요약")).toBeInTheDocument();
    expect(screen.getByText("세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.")).toBeInTheDocument();
    expect(screen.getByText("적용 가능한 제안 1개 · 제외된 제안 2개")).toBeInTheDocument();

    rerender(<DocumentShell aiRuns={[createAiRun("run_1")]} document={document} proposals={[createProposal("proposal_1")]} templates={templates} />);

    expect(screen.getByText("세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.")).toBeInTheDocument();
  });

  it("preserves an all-skipped review snapshot across same-document proposal refreshes", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          review: {
            summary: "모든 발견 사항이 본문에 안전하게 적용되지 않아 제외되었습니다.",
            findings: [
              {
                problem: "Ambiguous target",
                reason: "The target appears more than once.",
                targetText: "ambiguous",
                replacementText: "specific text",
              },
            ],
          },
          proposals: [],
          skippedProposalCount: 1,
        }),
      ),
    );
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "body");
    const templates = [createTemplate("tpl_1", "Board review")];

    const { rerender } = render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토가 완료되었고 적용 가능한 제안은 없습니다.")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_old")]}
        document={document}
        proposals={[createProposal("proposal_stale", "pending", "stale proposal target")]}
        templates={templates}
      />,
    );

    expect(screen.getByText("검토가 완료되었고 적용 가능한 제안은 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("stale proposal target")).not.toBeInTheDocument();
  });

  it("clears the previous review snapshot when a new document review fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_1"),
            review: {
              summary: "이전 검토 요약입니다.",
              findings: [
                {
                  problem: "Unclear evidence",
                  reason: "The source is missing.",
                  targetText: "growth was good",
                  replacementText: "revenue grew 8%",
                },
              ],
            },
            proposals: [createProposal("proposal_1")],
            skippedProposalCount: 0,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good");
    const templates = [createTemplate("tpl_1", "Board review")];

    render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("이전 검토 요약입니다.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토에 실패했습니다. 다시 시도하세요.")).toBeInTheDocument();
    expect(screen.queryByText("이전 검토 요약입니다.")).not.toBeInTheDocument();
  });

  it("validates cleared required template variables before review", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "대상 독자" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(screen.getByText("대상 독자 필드는 필수입니다.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends template variable values with full 문서 검토 requests", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          proposals: [],
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "대상 독자" }));
    await user.type(screen.getByRole("textbox", { name: "대상 독자" }), "Board");
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/review",
      expect.objectContaining({
        body: expect.stringContaining('"variables":{"audience":"Board"}'),
      }),
    );
  });

  it("persists proposal status changes and rolls back failed updates", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1"), createProposal("proposal_2", "pending", "owner is unclear")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "replace" }),
      }),
    );
    expect(screen.getByText("수락됨")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "owner is unclear 제안 거절" }));

    expect(screen.getByText("대기 중")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("replaces accepted proposal text in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "replace" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
  });

  it("replaces accepted proposal text across selected list items in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proposal: { ...createProposal("proposal_list"), status: "accepted" } })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "List review",
          plainText: "First item.\nSecond item.\nThird item.",
          contentJson: {
            type: "doc" as const,
            content: [
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
                  },
                ],
              },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_list", "pending", "First item.\nSecond item."),
            replacementText: "Combined replacement.",
            targetFrom: 3,
            targetTo: 30,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /제안으로 교체/ }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_list",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "replace" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Combined replacement.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Third item.");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("First item.");
    expect(screen.queryByText("제안 상태를 업데이트하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("inserts accepted proposal text below selected list items in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          proposal: {
            ...createProposal("proposal_list"),
            status: "accepted",
            appliedMode: "insert_below",
          },
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "List review",
          plainText: "First item.\nSecond item.\nThird item.",
          contentJson: {
            type: "doc" as const,
            content: [
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
                  },
                ],
              },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_list", "pending", "First item.\nSecond item."),
            defaultApplyMode: "insert_below",
            replacementText: "Inserted suggestion.",
            targetFrom: 3,
            targetTo: 30,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /제안을 아래에 추가/ }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_list",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "insert_below" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("First item.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Second item.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Inserted suggestion.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Third item.");
    expect(screen.queryByText("제안 상태를 업데이트하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("does not apply a selection proposal to another occurrence when its stored range is stale", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proposal: { ...createProposal("proposal_stale"), status: "accepted" } })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "Stale selection",
          plainText: "Edited text\nTarget text",
          contentJson: {
            type: "doc" as const,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Edited text" }] },
              { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_stale", "pending", "Target text"),
            replacementText: "Replacement text",
            source: "selection",
            targetFrom: 1,
            targetTo: 12,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Target text 제안으로 교체" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Target text");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("Replacement text");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("inserts accepted proposal text below the target in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안을 아래에 추가" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", appliedMode: "insert_below" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
  });

  it("records accepted changes and can undo the latest local AI application", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "pending" } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");

    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await user.click(screen.getByRole("button", { name: "growth was good 변경 되돌리기" }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/proposals/proposal_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "pending" }),
      }),
    );
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("revenue grew 8%");
  });

  it("keeps title edits made after accepting a proposal when undoing the AI change", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "pending" } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited title after apply");
    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await user.click(screen.getByRole("button", { name: "growth was good 변경 되돌리기" }));

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Edited title after apply");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
  });

  it("does not roll back newer edits when bulk accept persistence fails", async () => {
    const user = userEvent.setup();
    const failedPatch = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(failedPatch.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      failedPatch.resolve(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));
      await failedPatch.promise;
    });

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
  });

  it("bulk accepts range-backed proposals from the end of the document first", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const proposalId = url.includes("proposal_alpha") ? "proposal_alpha" : "proposal_beta";
      return new Response(
        JSON.stringify({
          proposal: {
            ...createProposal(proposalId),
            status: "accepted",
          },
        }),
      );
    });

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "Range bulk accept",
          plainText: "Alpha.\nBeta.",
          contentJson: {
            type: "doc" as const,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Alpha." }] },
              { type: "paragraph", content: [{ type: "text", text: "Beta." }] },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_alpha", "pending", "Alpha."),
            replacementText: "Alpha replacement is much longer.",
            source: "selection",
            targetFrom: 1,
            targetTo: 7,
          },
          {
            ...createProposal("proposal_beta", "pending", "Beta."),
            replacementText: "Beta replacement.",
            source: "selection",
            targetFrom: 9,
            targetTo: 14,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Alpha replacement is much longer.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Beta replacement.");
    expect(screen.queryByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).not.toBeInTheDocument();
  });

  it("does not bulk accept a current-session proposal after the draft content changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("marks the requested review proposal as the active inline suggestion", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "Company may use Customer Data.")}
        proposals={[createProposal("proposal_contract", "pending", "Customer Data")]}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Customer Data 제안을 본문에서 보기" }));

    expect(screen.getByTestId("mock-inline-suggestions")).toHaveTextContent(
      '"id":"proposal_contract","active":true',
    );
  });

  it("clears active proposal focus after a new 문서 검토 replaces proposals", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_new"),
          proposals: [createProposal("proposal_new", "pending", "new risk")],
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "Company may use Customer Data. new risk")}
        proposals={[createProposal("proposal_contract", "pending", "Customer Data")]}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Customer Data 제안을 본문에서 보기" }));
    expect(screen.getByTestId("mock-inline-suggestions")).toHaveTextContent('"active":true');

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    await waitFor(() => {
      expect(screen.getByTestId("mock-inline-suggestions")).not.toHaveTextContent('"active":true');
    });
  });

  it("refreshes same-document AI runs and proposals without clobbering dirty edits", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        proposals={[]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_1")]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local dirty title");
    expect(screen.getAllByText("growth was good").length).toBeGreaterThan(0);
    expect(screen.getAllByText("문서 검토").length).toBeGreaterThan(0);
  });
});

describe("SelectionAiMenu", () => {
  it("prevents mouse down from clearing the editor selection", () => {
    render(<SelectionAiMenu hasSelection onCommand={() => undefined} selectedText="selected text" />);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const allowed = screen.getByRole("button", { name: "명확하게 개선" }).dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the floating toolbar outside the document text flow", () => {
    render(
      <SelectionAiMenu
        hasSelection
        left={120}
        onCommand={() => undefined}
        side="top"
        selectedText="A selected sentence for review"
        top={48}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "선택 AI 작업" });
    expect(toolbar).toHaveAttribute("data-side", "top");
    expect(toolbar).toHaveClass("absolute");
    expect(toolbar).not.toHaveClass("sticky");
    expect(toolbar).toHaveStyle({ left: "120px", top: "48px" });
    expect(screen.queryByText("A selected sentence for review")).not.toBeInTheDocument();
  });

  it("offers translation commands for selected text", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "한국어로 번역" }));
    await user.click(screen.getByRole("button", { name: "영어로 번역" }));

    expect(handleCommand).toHaveBeenNthCalledWith(1, "Translate to Korean");
    expect(handleCommand).toHaveBeenNthCalledWith(2, "Translate to English");
  });

  it("renders plugin-provided selection commands", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(
      <SelectionAiMenu
        commands={[
          {
            ariaLabel: "법률 리스크 완화",
            command: "Mitigate legal risk",
            icon: "sparkles",
            id: "legal-risk",
            label: "리스크",
          },
        ]}
        hasSelection
        onCommand={handleCommand}
        selectedText="selected text"
      />,
    );

    await user.click(screen.getByRole("button", { name: "법률 리스크 완화" }));

    expect(handleCommand).toHaveBeenCalledWith("Mitigate legal risk");
    expect(screen.queryByRole("button", { name: "한국어로 번역" })).not.toBeInTheDocument();
  });

  it("offers a continue writing command for selected text", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "이어서 쓰기" }));

    expect(handleCommand).toHaveBeenCalledWith("Continue writing");
  });

  it("renders selection commands with Korean labels", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection language="ko" onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "한국어로 번역" }));
    await user.click(screen.getByRole("button", { name: "영어로 번역" }));

    expect(handleCommand).toHaveBeenNthCalledWith(1, "Translate to Korean");
    expect(handleCommand).toHaveBeenNthCalledWith(2, "Translate to English");
  });

  it("renders continue writing with a Korean label", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection language="ko" onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "이어서 쓰기" }));

    expect(handleCommand).toHaveBeenCalledWith("Continue writing");
  });

  it("shows an in-place running status for the active command", () => {
    const handleCommand = vi.fn();

    render(
      <SelectionAiMenu
        hasSelection
        isRunning
        onCommand={handleCommand}
        runningCommand="Translate to Korean"
        selectedText="selected text"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("한국어로 번역 실행 중...");
    expect(screen.queryByRole("button", { name: "한국어로 번역" })).not.toBeInTheDocument();
  });
});
