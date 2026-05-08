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
});
