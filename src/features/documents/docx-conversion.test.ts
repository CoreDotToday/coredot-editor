import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { docxBufferToTiptapJson, tiptapJsonToDocxBuffer } from "./docx-conversion";
import { extractPlainTextFromTiptap } from "./tiptap-text";

describe("DOCX conversion", () => {
  it("exports Tiptap JSON to a DOCX buffer with core document text", async () => {
    const buffer = await tiptapJsonToDocxBuffer(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Market Entry" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Revenue " },
              { type: "text", marks: [{ type: "bold" }], text: "grew" },
              { type: "text", text: " with evidence." },
            ],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First point" }] }] },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second point" }] }],
              },
            ],
          },
        ],
      },
      "Market Entry",
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const html = (await mammoth.convertToHtml({ buffer })).value;
    expect(html).toContain("Market Entry");
    expect(html).toContain("Revenue");
    expect(html).toContain("First point");
  });

  it("imports a generated DOCX buffer back into Tiptap JSON", async () => {
    const buffer = await tiptapJsonToDocxBuffer(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Imported Heading" }] },
          { type: "paragraph", content: [{ type: "text", text: "Imported paragraph" }] },
          {
            type: "orderedList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First item" }] }] },
            ],
          },
        ],
      },
      "Imported Document",
    );

    const result = await docxBufferToTiptapJson(buffer);

    expect(result.warnings).toEqual([]);
    expect(result.contentJson.type).toBe("doc");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("Imported Heading");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("Imported paragraph");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("First item");
  });
});
