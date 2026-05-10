import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentShell } from "./DocumentShell";
import { SelectionAiMenu } from "./SelectionAiMenu";

vi.mock("./DocumentEditor", () => ({
  DocumentEditor: ({
    contentJson,
    onChange,
    onSelectionCommand,
    title,
  }: {
    contentJson: { type: "doc"; content?: unknown[] };
    onChange: (draft: { title: string; contentJson: { type: "doc"; content?: unknown[] } }) => void;
    onSelectionCommand?: (command: string, selectedText: string) => void;
    title: string;
  }) => (
    <div>
      <input
        aria-label="Document title"
        onChange={(event) => onChange({ title: event.currentTarget.value, contentJson })}
        value={title}
      />
      <button onClick={() => onSelectionCommand?.("Improve clarity", "selected text")} type="button">
        Mock selection command
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
    </div>
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
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

    expect(screen.getByText("Outline")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Market Entry Memo");
    expect(screen.getByText("AI Review")).toBeInTheDocument();
  });

  it("keeps newer unsaved edits dirty when an older save resolves", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Market Entry Memo v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(titleInput, " updated");

    await act(async () => {
      deferredSave.resolve(new Response(JSON.stringify({ document: createDocument("doc_1", "Market Entry Memo v2") })));
      await deferredSave.promise;
    });

    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("resets the title textbox when rerendered with a different document", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Edited title");

    rerender(<DocumentShell aiRuns={[]} document={createDocument("doc_2", "Board Brief")} templates={[]} />);

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Board Brief");
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

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Market Entry Memo Updated");
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

    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Local dirty title");
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

    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Saving local title");
    await user.click(screen.getByRole("button", { name: "Save" }));

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Saving local title");
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

    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Failed local title");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await act(async () => {
      deferredSave.reject(new Error("network"));
      await deferredSave.promise.catch(() => undefined);
    });

    expect(screen.getByText("Save failed")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Failed local title");
  });

  it("reflects the last selection command in the AI panel", async () => {
    const user = userEvent.setup();

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    expect(screen.getByText("Last selection command: Improve clarity")).toBeInTheDocument();
    expect(screen.getByText("Selected: selected text")).toBeInTheDocument();
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
    expect(await screen.findByText("selected text")).toBeInTheDocument();
    expect(screen.getByText("revenue grew 8%")).toBeInTheDocument();
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

    expect(screen.getByRole("textbox", { name: "Audience" })).toHaveValue("Executive stakeholders");
    expect(screen.getByRole("textbox", { name: "Document objective" })).toHaveValue(
      "Improve the selected text while preserving the document's intent.",
    );
    expect(screen.getByRole("combobox", { name: "Tone" })).toHaveValue("executive");

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
    expect(screen.queryByText("Fill required template fields before running selection AI.")).not.toBeInTheDocument();
  });

  it("runs a full document review with current unsaved draft text", async () => {
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
    await user.click(screen.getByRole("button", { name: "Review document" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/review",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"documentText":"fresh edited body"'),
      }),
    );
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

    await user.clear(screen.getByRole("textbox", { name: "Audience" }));
    await user.click(screen.getByRole("button", { name: "Review document" }));

    expect(screen.getByText("Audience is required")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends template variable values with full document review requests", async () => {
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

    await user.clear(screen.getByRole("textbox", { name: "Audience" }));
    await user.type(screen.getByRole("textbox", { name: "Audience" }), "Board");
    await user.click(screen.getByRole("button", { name: "Review document" }));

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
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        proposals={[createProposal("proposal_1"), createProposal("proposal_2", "pending", "owner is unclear")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Accept proposal for growth was good" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proposals/proposal_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "accepted" }),
      }),
    );
    expect(screen.getByText("Accepted")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reject proposal for owner is unclear" }));

    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not update proposal status.");
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

    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_1")]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Local dirty title");
    expect(screen.getByText("growth was good")).toBeInTheDocument();
    expect(screen.getByText("document review")).toBeInTheDocument();
  });
});

describe("SelectionAiMenu", () => {
  it("prevents mouse down from clearing the editor selection", () => {
    render(<SelectionAiMenu hasSelection onCommand={() => undefined} selectedText="selected text" />);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const allowed = screen.getByRole("button", { name: "Improve clarity" }).dispatchEvent(event);

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

    const toolbar = screen.getByRole("toolbar", { name: "Selection AI actions" });
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

    await user.click(screen.getByRole("button", { name: "Translate to Korean" }));
    await user.click(screen.getByRole("button", { name: "Translate to English" }));

    expect(handleCommand).toHaveBeenNthCalledWith(1, "Translate to Korean");
    expect(handleCommand).toHaveBeenNthCalledWith(2, "Translate to English");
  });
});
