import mammoth from "mammoth";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxBufferToTiptapJson, tiptapJsonToDocxBuffer } from "./docx-conversion";
import { createDocumentInterchange } from "./document-interchange";
import { extractPlainTextFromTiptap } from "./tiptap-text";

describe("DOCX conversion", () => {
  it("renders the fidelity corpus according to the worker core behavior", async () => {
    const buffer = await tiptapJsonToDocxBuffer({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "제목" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "굵게" },
            { type: "text", text: " " },
            { type: "text", marks: [{ type: "italic" }], text: "기울임" },
            { type: "text", text: " " },
            { type: "text", marks: [{ type: "strike" }], text: "취소선" },
            { type: "text", text: " " },
            {
              type: "text",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
              text: "링크",
            },
          ],
        },
        {
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "상위" }] },
              {
                type: "orderedList",
                content: [{
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "하위" }] }],
                }],
              },
            ],
          }],
        },
        {
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: true },
            content: [{ type: "paragraph", content: [{ type: "text", text: "완료" }] }],
          }],
        },
        {
          type: "table",
          content: [{
            type: "tableRow",
            content: [{
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "셀" }] }],
            }],
          }],
        },
        {
          type: "customCallout",
          content: [{ type: "paragraph", content: [{ type: "text", text: "알 수 없는 블록" }] }],
        },
      ],
    });

    const html = (await mammoth.convertToHtml({ buffer })).value;

    expect(html).toContain("<h2>제목</h2>");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<em>기울임</em>");
    expect(html).toContain("<s>취소선</s>");
    expect(html).toContain('<a href="https://example.com">링크</a>');
    expect(html).toContain("<li>상위하위</li>");
    expect(html).toContain("<li>[x] 완료</li>");
    expect(html).toContain("<p>셀</p>");
    expect(html).toContain("<p>알 수 없는 블록</p>");
    expect(html).not.toContain("<table>");
    expect(html).not.toContain("<ol>");
  });

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

  it("renders an unusable link target as plain text instead of a broken DOCX hyperlink", async () => {
    const buffer = await tiptapJsonToDocxBuffer({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          marks: [{ type: "link", attrs: { href: "not a usable URL" } }],
          text: "Broken link",
        }],
      }],
    });

    const html = (await mammoth.convertToHtml({ buffer })).value;

    expect(html).toContain("<p>Broken link</p>");
    expect(html).not.toContain("<a");
  });

  it("restarts separate top-level ordered lists with distinct DOCX numbering instances", async () => {
    const contentJson = {
      type: "doc" as const,
      content: [
        {
          type: "orderedList",
          content: ["First", "Second"].map((text) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
        { type: "paragraph", content: [{ type: "text", text: "Separator" }] },
        {
          type: "orderedList",
          content: [{
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Restarted" }] }],
          }],
        },
      ],
    };
    const preview = await createDocumentInterchange().previewExport(contentJson);
    const buffer = await tiptapJsonToDocxBuffer(contentJson);
    const archive = await JSZip.loadAsync(buffer);
    const documentXml = await archive.file("word/document.xml")?.async("string");
    const paragraphs = documentXml?.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu) ?? [];
    const numberingFor = (text: string) => paragraphs
      .find((paragraph) => paragraph.includes(`>${text}<`))
      ?.match(/<w:numId w:val="(\d+)"\s*\/>/u)?.[1];

    expect(numberingFor("First")).toBe(numberingFor("Second"));
    expect(numberingFor("Restarted")).toBeDefined();
    expect(numberingFor("Restarted")).not.toBe(numberingFor("First"));
    expect(preview).toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "list", outcome: "preserved" }]),
        requiresAcknowledgement: false,
      },
      ok: true,
    });
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
    expect(result.features).toEqual(expect.arrayContaining(["heading", "paragraph", "orderedList"]));
    expect(result.contentJson.type).toBe("doc");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("Imported Heading");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("Imported paragraph");
    expect(extractPlainTextFromTiptap(result.contentJson)).toContain("First item");
  });
});
