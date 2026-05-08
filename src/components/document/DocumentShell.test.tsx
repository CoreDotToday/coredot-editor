import { act, render, screen } from "@testing-library/react";
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

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
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

  it("reflects the last selection command in the AI panel", async () => {
    const user = userEvent.setup();

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    expect(screen.getByText("Last selection command: Improve clarity")).toBeInTheDocument();
  });
});

describe("SelectionAiMenu", () => {
  it("prevents mouse down from clearing the editor selection", () => {
    render(<SelectionAiMenu hasSelection onCommand={() => undefined} />);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const allowed = screen.getByRole("button", { name: "Improve clarity" }).dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });
});
