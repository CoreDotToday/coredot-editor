import { describe, expect, it } from "vitest";
import { buildDocumentSourceSnapshot } from "./document-source-view-model";

describe("buildDocumentSourceSnapshot", () => {
  it("builds plain text and pretty JSON from a Tiptap draft", () => {
    const snapshot = buildDocumentSourceSnapshot({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "검토 문서" }] }],
      },
      title: "Contract",
    });

    expect(snapshot.plainText).toBe("검토 문서");
    expect(snapshot.jsonText).toContain('"type": "doc"');
    expect(snapshot.isJsonValid).toBe(true);
    expect(snapshot.downloadFileName).toBe("Contract.source.json");
  });

  it("uses a stable fallback download name for untitled documents", () => {
    const snapshot = buildDocumentSourceSnapshot({
      contentJson: { type: "doc", content: [] },
      title: "  ",
    });

    expect(snapshot.downloadFileName).toBe("document.source.json");
  });
});
