import { describe, expect, it } from "vitest";
import { extractPlainTextFromTiptap } from "./tiptap-text";

describe("extractPlainTextFromTiptap", () => {
  it("extracts nested text and separates blocks with line breaks", () => {
    const text = extractPlainTextFromTiptap({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Market Entry" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Target " },
            { type: "text", text: "enterprise buyers" },
          ],
        },
      ],
    });

    expect(text).toBe("Market Entry\nTarget enterprise buyers");
  });

  it("separates adjacent code blocks with line breaks", () => {
    const text = extractPlainTextFromTiptap({
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a = 1;" }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let b = 2;" }] },
      ],
    });

    expect(text).toBe("let a = 1;\nlet b = 2;");
  });
});
