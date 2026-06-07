import { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentSchemaExtensions } from "@/features/documents/tiptap-extensions";
import {
  countTextOccurrences,
  getEditorAiCommandTarget,
  getEditorAiCommandTargetFromTargets,
  getEditorAiCommandTargets,
} from "./editor-command-targets";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

describe("editor command targets", () => {
  it("orders selected text before current block and full document targets", () => {
    const editor = createEditor(["First block.", "Second block."]);
    const selection = findTextRange(editor, "Second");
    editor.commands.setTextSelection(selection);

    const targets = getEditorAiCommandTargets(editor);

    expect(targets.map((target) => target.scope)).toEqual(["selection", "currentBlock", "document"]);
    expect(targets[0]).toMatchObject({
      occurrenceIndex: 0,
      selectedText: "Second",
      selectionRange: selection,
    });
    expect(targets[1]).toMatchObject({
      occurrenceIndex: 0,
      selectedText: "Second block.",
      scope: "currentBlock",
    });
    expect(targets[2]).toMatchObject({
      occurrenceIndex: 0,
      selectedText: "First block.\nSecond block.",
      scope: "document",
    });
  });

  it("uses the preferred scope when that target is available", () => {
    const editor = createEditor(["First block.", "Second block."]);
    editor.commands.setTextSelection(findTextRange(editor, "Second"));

    expect(getEditorAiCommandTarget(editor, "document")).toMatchObject({
      scope: "document",
      selectedText: "First block.\nSecond block.",
    });
    expect(getEditorAiCommandTarget(editor, null)).toMatchObject({
      scope: "selection",
      selectedText: "Second",
    });
    expect(getEditorAiCommandTargetFromTargets(getEditorAiCommandTargets(editor), "document")).toMatchObject({
      scope: "document",
      selectedText: "First block.\nSecond block.",
    });
  });

  it("counts repeated current-block occurrences before the current block", () => {
    const editor = createEditor(["Repeat.", "Repeat."]);
    const secondRepeat = findTextRange(editor, "Repeat.", 1);
    editor.commands.setTextSelection({ from: secondRepeat.from, to: secondRepeat.from });

    expect(getEditorAiCommandTarget(editor, "currentBlock")).toMatchObject({
      occurrenceIndex: 1,
      scope: "currentBlock",
      selectedText: "Repeat.",
    });
  });

  it("treats an empty occurrence target as zero matches", () => {
    expect(countTextOccurrences("abc", "")).toBe(0);
  });
});

function createEditor(paragraphs: string[]) {
  const editor = new Editor({
    content: {
      type: "doc",
      content: paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    },
    extensions: createDocumentSchemaExtensions(),
  });
  editors.push(editor);
  return editor;
}

function findTextRange(editor: Editor, text: string, occurrenceIndex = 0): { from: number; to: number } {
  let remaining = occurrenceIndex;
  let found: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText || !node.text) return true;

    let offset = node.text.indexOf(text);
    while (offset !== -1) {
      if (remaining === 0) {
        found = { from: pos + offset, to: pos + offset + text.length };
        return false;
      }
      remaining -= 1;
      offset = node.text.indexOf(text, offset + 1);
    }

    return true;
  });

  const range = found as { from: number; to: number } | null;
  if (!range) {
    throw new Error(`Text not found: ${text}`);
  }

  return range;
}
