import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { getNotionModASelectionRange } from "./notion-mod-a-selection";

const testSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

function paragraphDoc(...paragraphs: string[]) {
  return testSchema.node(
    "doc",
    null,
    paragraphs.map((paragraph) => testSchema.node("paragraph", null, paragraph ? [testSchema.text(paragraph)] : [])),
  );
}

function stateWithSelection(selection: TextSelection | AllSelection) {
  return EditorState.create({
    doc: selection.$anchor.doc,
    schema: testSchema,
    selection,
  });
}

describe("getNotionModASelectionRange", () => {
  it("selects the current text block on the first Mod+A", () => {
    const doc = paragraphDoc("First paragraph.", "Second paragraph.");
    const state = stateWithSelection(TextSelection.create(doc, 4));

    expect(getNotionModASelectionRange(state)).toEqual({
      from: 1,
      mode: "block",
      to: "First paragraph.".length + 1,
    });
  });

  it("selects the whole document when the current block is already selected", () => {
    const doc = paragraphDoc("First paragraph.", "Second paragraph.");
    const state = stateWithSelection(TextSelection.create(doc, 1, "First paragraph.".length + 1));

    expect(getNotionModASelectionRange(state)).toEqual({
      from: 0,
      mode: "all",
      to: doc.content.size,
    });
  });

  it("selects the whole document when an existing selection spans multiple blocks", () => {
    const doc = paragraphDoc("First paragraph.", "Second paragraph.");
    const state = stateWithSelection(TextSelection.create(doc, 4, doc.content.size - 2));

    expect(getNotionModASelectionRange(state)).toEqual({
      from: 0,
      mode: "all",
      to: doc.content.size,
    });
  });

  it("selects the previous text block when the cursor is at the document end boundary", () => {
    const doc = paragraphDoc("First paragraph.", "Second paragraph.");
    const state = stateWithSelection(TextSelection.create(doc, doc.content.size));

    expect(getNotionModASelectionRange(state)).toEqual({
      from: doc.content.size - "Second paragraph.".length - 1,
      mode: "block",
      to: doc.content.size - 1,
    });
  });
});
