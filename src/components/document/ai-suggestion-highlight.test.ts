import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { findSuggestionDecorationRanges } from "./ai-suggestion-highlight";

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

function paragraphDoc(text: string) {
  return testSchema.node("doc", null, [testSchema.node("paragraph", null, [testSchema.text(text)])]);
}

function multiParagraphDoc(firstText: string, secondText: string) {
  return testSchema.node("doc", null, [
    testSchema.node("paragraph", null, [testSchema.text(firstText)]),
    testSchema.node("paragraph", null, [testSchema.text(secondText)]),
  ]);
}

describe("findSuggestionDecorationRanges", () => {
  it("finds the unique matching target text in a ProseMirror document", () => {
    const ranges = findSuggestionDecorationRanges(paragraphDoc("Revenue retention needs clearer evidence."), [
      {
        id: "proposal_1",
        occurrenceIndex: null,
        source: "review",
        targetText: "retention needs",
      },
    ]);

    expect(ranges).toEqual([{ from: 9, id: "proposal_1", source: "review", to: 24 }]);
  });

  it("uses occurrence index to highlight the captured selection when text repeats", () => {
    const ranges = findSuggestionDecorationRanges(paragraphDoc("repeat repeat"), [
      {
        id: "proposal_2",
        occurrenceIndex: 1,
        source: "selection",
        targetText: "repeat",
      },
    ]);

    expect(ranges).toEqual([{ from: 8, id: "proposal_2", source: "selection", to: 14 }]);
  });

  it("marks the active proposal range", () => {
    const ranges = findSuggestionDecorationRanges(paragraphDoc("Customer Data may be retained."), [
      {
        active: true,
        id: "proposal_active",
        occurrenceIndex: null,
        source: "review",
        targetText: "Customer Data",
      },
    ]);

    expect(ranges).toEqual([{ active: true, from: 1, id: "proposal_active", source: "review", to: 14 }]);
  });

  it("skips ambiguous review suggestions without an occurrence index", () => {
    const ranges = findSuggestionDecorationRanges(paragraphDoc("repeat repeat"), [
      {
        id: "proposal_3",
        occurrenceIndex: null,
        source: "review",
        targetText: "repeat",
      },
    ]);

    expect(ranges).toEqual([]);
  });

  it("finds a target that spans multiple text blocks", () => {
    const ranges = findSuggestionDecorationRanges(multiParagraphDoc("First.", "Second."), [
      {
        id: "proposal_multiblock",
        occurrenceIndex: 0,
        source: "review",
        targetText: "First.\nSecond.",
      },
    ]);

    expect(ranges).toEqual([{ from: 1, id: "proposal_multiblock", source: "review", to: 16 }]);
  });

  it("uses a valid stored selection range before text matching", () => {
    const ranges = findSuggestionDecorationRanges(multiParagraphDoc("First.", "Second."), [
      {
        id: "proposal_selection",
        occurrenceIndex: null,
        selectionRange: { from: 9, to: 16 },
        source: "selection",
        targetText: "Second.",
      },
    ]);

    expect(ranges).toEqual([{ from: 9, id: "proposal_selection", source: "selection", to: 16 }]);
  });
});
