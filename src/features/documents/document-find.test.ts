import { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentSchemaExtensions } from "./tiptap-extensions";
import {
  findDocumentMatches,
  nextDocumentFindIndex,
  replaceAllDocumentMatches,
  replaceDocumentMatch,
} from "./document-find";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

describe("document find helpers", () => {
  it("finds case-insensitive literal matches and wraps navigation", () => {
    const editor = createEditor(["Revenue retention", "revenue renewal"]);
    const result = findDocumentMatches(editor.state.doc, "revenue", { caseSensitive: false, regex: false });

    expect(result.error).toBeNull();
    expect(result.matches.map((match) => match.text)).toEqual(["Revenue", "revenue"]);
    expect(nextDocumentFindIndex(1, result.matches.length, 1)).toBe(0);
    expect(nextDocumentFindIndex(0, result.matches.length, -1)).toBe(1);
  });

  it("respects case-sensitive searches", () => {
    const editor = createEditor(["Revenue revenue"]);
    const result = findDocumentMatches(editor.state.doc, "Revenue", { caseSensitive: true, regex: false });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ text: "Revenue" });
  });

  it("returns an error for invalid regex patterns", () => {
    const editor = createEditor(["Revenue"]);
    const result = findDocumentMatches(editor.state.doc, "(", { caseSensitive: false, regex: true });

    expect(result).toEqual({ error: "invalid_regex", matches: [] });
  });

  it("finds matches across split marked text nodes", () => {
    const editor = new Editor({
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "rev" },
              { type: "text", marks: [{ type: "bold" }], text: "enue" },
            ],
          },
        ],
      },
      extensions: createDocumentSchemaExtensions(),
    });
    editors.push(editor);

    const result = findDocumentMatches(editor.state.doc, "revenue", { caseSensitive: false, regex: false });

    expect(result.matches).toHaveLength(1);
    expect(editor.state.doc.textBetween(result.matches[0]!.from, result.matches[0]!.to)).toBe("revenue");
  });

  it("does not match across separate text block boundaries", () => {
    const editor = createEditor(["hello", "world"]);
    const result = findDocumentMatches(editor.state.doc, "lowo", { caseSensitive: false, regex: false });

    expect(result.error).toBeNull();
    expect(result.matches).toEqual([]);
  });

  it("replaces the selected match and all matches through editor transactions", () => {
    const editor = createEditor(["Revenue retention. Revenue evidence."]);
    const result = findDocumentMatches(editor.state.doc, "Revenue", { caseSensitive: true, regex: false });

    replaceDocumentMatch(editor, result.matches[0]!, "매출");
    expect(editor.state.doc.textContent).toBe("매출 retention. Revenue evidence.");

    const nextResult = findDocumentMatches(editor.state.doc, "Revenue", { caseSensitive: true, regex: false });
    replaceAllDocumentMatches(editor, nextResult.matches, "매출");
    expect(editor.state.doc.textContent).toBe("매출 retention. 매출 evidence.");
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
