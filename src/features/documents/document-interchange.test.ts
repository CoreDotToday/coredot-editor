import {
  Document,
  Footer,
  Header,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
} from "docx";
import { describe, expect, it, vi } from "vitest";
import type { TiptapJson } from "@/db/schema";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { createDocumentInterchange, documentInterchange } from "./document-interchange";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZbL8AAAAASUVORK5CYII=",
  "base64",
);

const preservedDocument: TiptapJson = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "안녕하세요" }] }],
};

const fidelityCorpus: TiptapJson = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "제목" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", marks: [{ type: "bold" }], text: "굵게" },
        { type: "text", marks: [{ type: "italic" }], text: "기울임" },
        { type: "text", marks: [{ type: "strike" }], text: "취소선" },
        { type: "text", marks: [{ type: "link", attrs: { href: "https://example.com" } }], text: "링크" },
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
};

function createHarness() {
  const importDocx = vi.fn(async () => ({
    contentJson: preservedDocument,
    features: ["paragraph", "text"],
    sourceFeatures: [],
    warnings: [] as string[],
  }));
  const exportDocx = vi.fn(async () => Buffer.from("docx"));
  return {
    exportDocx,
    importDocx,
    interchange: createDocumentInterchange({ exportDocx, importDocx }),
  };
}

describe("document interchange", () => {
  it("reports an embedded source image removed by the Tiptap import schema", async () => {
    const bytes = await Packer.toBuffer(new Document({
      sections: [{
        children: [new Paragraph({
          children: [
            new TextRun("Before "),
            new ImageRun({ data: ONE_PIXEL_PNG, transformation: { height: 1, width: 1 }, type: "png" }),
            new TextRun(" after"),
          ],
        })],
      }],
    }));

    const result = await documentInterchange.import({ bytes, fileName: "with-image.docx" });

    expect(result).toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "image", outcome: "removed" }]),
        requiresAcknowledgement: true,
      },
      ok: true,
    });
  });

  it("preserves known simple features while conservatively requiring DOCX formatting review", async () => {
    const bytes = await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph({ children: [new TextRun("Supported heading")], heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ bold: true, text: "Supported body" })] }),
        ],
      }],
    }));

    const result = await documentInterchange.import({ bytes, fileName: "supported.docx" });

    expect(result).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: true } });
    if (!result.ok) throw new Error("Expected supported import");
    expect(result.fidelity.items).toEqual(expect.arrayContaining([
      { feature: "heading", outcome: "preserved" },
      { feature: "paragraph", outcome: "preserved" },
      { feature: "bold", outcome: "preserved" },
      { feature: "docx-formatting", outcome: "approximated" },
    ]));
  });

  it("normalizes a real list and table import to canonical user-facing features", async () => {
    const bytes = await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph({ bullet: { level: 0 }, text: "Listed item" }),
          new Table({
            rows: [new TableRow({
              children: [new TableCell({ children: [new Paragraph("Table cell")] })],
            })],
          }),
        ],
      }],
    }));

    const result = await documentInterchange.import({ bytes, fileName: "list-table.docx" });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected list/table import");
    expect(result.fidelity.items).toEqual(expect.arrayContaining([
      { feature: "list", outcome: "preserved" },
      { feature: "table", outcome: "preserved" },
      { feature: "paragraph", outcome: "preserved" },
    ]));
    expect(result.fidelity.items.map((item) => item.feature)).not.toEqual(expect.arrayContaining([
      "bulletList",
      "listItem",
      "tableRow",
      "tableCell",
      "text",
    ]));
  });

  it("deduplicates structural schema internals while canonicalizing imported block features", async () => {
    const { importDocx, interchange } = createHarness();
    importDocx.mockResolvedValueOnce({
      contentJson: preservedDocument,
      features: [
        "doc",
        "text",
        "bulletList",
        "orderedList",
        "listItem",
        "table",
        "tableRow",
        "tableCell",
        "hardBreak",
        "codeBlock",
        "horizontalRule",
        "taskList",
        "taskItem",
      ],
      sourceFeatures: [],
      warnings: [],
    });

    const result = await interchange.import({ bytes: new Uint8Array([1]), fileName: "schema-features.docx" });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected schema feature import");
    expect(result.fidelity.items).toEqual(expect.arrayContaining([
      { feature: "list", outcome: "preserved" },
      { feature: "table", outcome: "preserved" },
      { feature: "hard-break", outcome: "preserved" },
      { feature: "code-block", outcome: "preserved" },
      { feature: "horizontal-rule", outcome: "preserved" },
      { feature: "task-list", outcome: "preserved" },
    ]));
    expect(result.fidelity.items.filter((item) => item.feature === "list")).toHaveLength(1);
    expect(result.fidelity.items.map((item) => item.feature)).not.toEqual(expect.arrayContaining([
      "doc",
      "text",
      "listItem",
      "tableRow",
      "tableCell",
      "taskItem",
    ]));
  });

  it("reports header, footer, underline, color, and highlight removed from a real DOCX", async () => {
    const bytes = await Packer.toBuffer(new Document({
      sections: [{
        children: [new Paragraph({
          children: [new TextRun({
            color: "FF0000",
            highlight: HighlightColor.YELLOW,
            text: "Styled source",
            underline: { type: UnderlineType.SINGLE },
          })],
        })],
        footers: { default: new Footer({ children: [new Paragraph("Footer source content")] }) },
        headers: { default: new Header({ children: [new Paragraph("Header source content")] }) },
      }],
    }));

    const result = await documentInterchange.import({ bytes, fileName: "source-losses.docx" });

    expect(result).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: true } });
    if (!result.ok) throw new Error("Expected source loss import");
    expect(result.fidelity.items).toEqual(expect.arrayContaining([
      { feature: "header", outcome: "removed" },
      { feature: "footer", outcome: "removed" },
      { feature: "underline", outcome: "removed" },
      { feature: "text-color", outcome: "removed" },
      { feature: "highlight", outcome: "removed" },
    ]));
    expect(JSON.stringify(result.contentJson)).not.toContain("Header source content");
    expect(JSON.stringify(result.contentJson)).not.toContain("Footer source content");
  });

  it("classifies the actual DOCX export fidelity corpus before producing an artifact", async () => {
    const { exportDocx, interchange } = createHarness();

    const result = await interchange.previewExport(fidelityCorpus);

    expect(result).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: true } });
    if (!result.ok) throw new Error("Expected a fidelity preview");
    expect(result.fidelity.items).toEqual(expect.arrayContaining([
      { feature: "heading", outcome: "preserved" },
      { feature: "bold", outcome: "preserved" },
      { feature: "italic", outcome: "preserved" },
      { feature: "strike", outcome: "preserved" },
      { feature: "link", outcome: "preserved" },
      { feature: "nested-list", outcome: "approximated" },
      { feature: "task-list", outcome: "approximated" },
      { feature: "table", outcome: "approximated" },
      { feature: "unknown:customCallout", outcome: "approximated" },
      { feature: "korean-text", outcome: "preserved" },
    ]));
    expect(exportDocx).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { href: "" }],
    ["non-string", { href: 42 }],
    ["invalid", { href: "not a usable URL" }],
  ])("requires acknowledgement for a %s export link target", async (_label, attrs) => {
    const { interchange } = createHarness();
    const contentJson: TiptapJson = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", marks: [{ type: "link", attrs }], text: "Broken link" }],
      }],
    };

    const result = await interchange.previewExport(contentJson);

    expect(result).toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "link", outcome: "removed" }]),
        requiresAcknowledgement: true,
      },
      ok: true,
    });
  });

  it("rejects an oversized import before conversion", async () => {
    const { importDocx, interchange } = createHarness();

    const result = await interchange.import({
      bytes: new Uint8Array(RESOURCE_LIMITS.docxBytes + 1),
      fileName: "large.docx",
    });

    expect(result).toEqual({ ok: false, reason: "resource_limit" });
    expect(importDocx).not.toHaveBeenCalled();
  });

  it("derives import fidelity from converted features and warnings", async () => {
    const { importDocx, interchange } = createHarness();
    importDocx.mockResolvedValueOnce({
      contentJson: preservedDocument,
      features: ["heading", "bold", "korean-text"],
      sourceFeatures: [],
      warnings: ["An unsupported image was ignored"],
    });

    const result = await interchange.import({ bytes: new Uint8Array([1, 2, 3]), fileName: "memo.docx" });

    expect(result).toMatchObject({
      ok: true,
      fidelity: {
        items: expect.arrayContaining([
          { feature: "heading", outcome: "preserved" },
          { feature: "bold", outcome: "preserved" },
          {
            feature: "conversion-warning",
            message: "An unsupported image was ignored",
            outcome: "removed",
          },
        ]),
        requiresAcknowledgement: true,
      },
      warnings: ["An unsupported image was ignored"],
    });
  });

  it("blocks lossy export without acknowledgement and does not call the converter", async () => {
    const { exportDocx, interchange } = createHarness();

    const result = await interchange.export({
      acknowledgedLoss: false,
      contentJson: fidelityCorpus,
      title: "Lossy draft",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "acknowledgement_required",
      fidelity: { requiresAcknowledgement: true },
    });
    expect(exportDocx).not.toHaveBeenCalled();
  });

  it("requires acknowledgement when an ordered list starts after one", async () => {
    const { interchange } = createHarness();
    const contentJson: TiptapJson = {
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 3 },
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Third" }] }],
        }],
      }],
    };

    const result = await interchange.previewExport(contentJson);

    expect(result).toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "ordered-list-start", outcome: "approximated" }]),
        requiresAcknowledgement: true,
      },
      ok: true,
    });
  });

  it("requires acknowledgement when one list item contains multiple block children", async () => {
    const { interchange } = createHarness();
    const contentJson: TiptapJson = {
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First block" }] },
            { type: "paragraph", content: [{ type: "text", text: "Second block" }] },
          ],
        }],
      }],
    };

    const result = await interchange.previewExport(contentJson);

    expect(result).toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "multi-block-list-item", outcome: "approximated" }]),
        requiresAcknowledgement: true,
      },
      ok: true,
    });
  });

  it("keeps a one-based list with one block per item fully preserved", async () => {
    const { interchange } = createHarness();
    const contentJson: TiptapJson = {
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 1 },
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }],
        }],
      }],
    };

    const result = await interchange.previewExport(contentJson);

    expect(result).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: false } });
    if (!result.ok) throw new Error("Expected export preview");
    expect(result.fidelity.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "ordered-list-start" }),
      expect.objectContaining({ feature: "multi-block-list-item" }),
    ]));
  });

  it("exports preserved content directly and lossy content after acknowledgement", async () => {
    const { exportDocx, interchange } = createHarness();

    const preservedResult = await interchange.export({ contentJson: preservedDocument, title: "Preserved" });
    const acknowledgedResult = await interchange.export({
      acknowledgedLoss: true,
      contentJson: fidelityCorpus,
      title: "Acknowledged",
    });

    expect(preservedResult).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: false } });
    expect(acknowledgedResult).toMatchObject({ ok: true, fidelity: { requiresAcknowledgement: true } });
    expect(exportDocx).toHaveBeenCalledTimes(2);
  });

  it("keeps its small caller methods safe to pass as standalone functions", async () => {
    const { interchange } = createHarness();
    const previewExport = interchange.previewExport;
    const exportDocument = interchange.export;

    await expect(previewExport(preservedDocument)).resolves.toMatchObject({ ok: true });
    await expect(exportDocument({ contentJson: preservedDocument, title: "Standalone" }))
      .resolves.toMatchObject({ ok: true });
  });
});
