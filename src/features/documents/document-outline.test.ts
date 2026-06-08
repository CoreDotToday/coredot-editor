import { describe, expect, it } from "vitest";
import { buildDocumentOutline } from "./document-outline";

describe("buildDocumentOutline", () => {
  it("builds a nested outline from top-level heading nodes", () => {
    const outline = buildDocumentOutline("Revenue Memo", {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Context" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evidence" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Customer data" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Risks" }] },
      ],
    });

    expect(outline.children).toMatchObject([
      {
        level: 1,
        title: "Context",
        topLevelIndex: 0,
        children: [
          {
            level: 2,
            title: "Evidence",
            topLevelIndex: 2,
            children: [{ level: 3, title: "Customer data", topLevelIndex: 3 }],
          },
          { level: 2, title: "Risks", topLevelIndex: 4 },
        ],
      },
    ]);
  });

  it("skips the first h1 when it duplicates the document title", () => {
    const outline = buildDocumentOutline("Revenue Memo", {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Revenue   Memo" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Executive summary" }] },
      ],
    });

    expect(outline.children).toHaveLength(1);
    expect(outline.children[0]).toMatchObject({
      level: 2,
      title: "Executive summary",
      topLevelIndex: 1,
    });
  });

  it("ignores unsupported heading levels and empty heading text", () => {
    const outline = buildDocumentOutline("Untitled", {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Too deep" }] },
        { type: "heading", attrs: { level: 1 }, content: [] },
        { type: "paragraph", content: [{ type: "text", text: "Not heading" }] },
      ],
    });

    expect(outline.children).toEqual([]);
  });
});
