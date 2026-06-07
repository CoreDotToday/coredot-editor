import { generateJSON } from "@tiptap/html/server";
import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import mammoth from "mammoth";
import type { TiptapJson } from "@/db/schema";
import { createDocumentSchemaExtensions } from "./tiptap-extensions";

type TiptapNode = {
  attrs?: Record<string, unknown>;
  content?: unknown[];
  marks?: Array<{ attrs?: Record<string, unknown>; type?: string }>;
  text?: string;
  type?: string;
};

type DocxInlineNode = TextRun | ExternalHyperlink;

const ORDERED_LIST_REFERENCE = "coredot-ordered-list";

export async function docxBufferToTiptapJson(buffer: Buffer) {
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value.trim() || "<p></p>";
  const contentJson = normalizeTiptapJson(generateJSON(html, createDocumentSchemaExtensions()));

  return {
    contentJson,
    warnings: result.messages.map((message) => message.message).filter(Boolean),
  };
}

export async function tiptapJsonToDocxBuffer(contentJson: TiptapJson, title = "Document") {
  const children = renderBlockNodes(contentJson.content ?? []);
  const document = new Document({
    creator: "Coredot Editor",
    description: "Exported from Coredot Editor",
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 260 },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: children.length > 0 ? children : [new Paragraph("")],
      },
    ],
    title,
  });

  return Packer.toBuffer(document);
}

function normalizeTiptapJson(value: Record<string, unknown>): TiptapJson {
  return {
    type: "doc",
    content: Array.isArray(value.content) && value.content.length > 0 ? value.content : [{ type: "paragraph" }],
  };
}

function renderBlockNodes(nodes: unknown[]): Paragraph[] {
  return nodes.flatMap((node) => (isTiptapNode(node) ? renderBlockNode(node) : []));
}

function renderBlockNode(node: TiptapNode): Paragraph[] {
  if (node.type === "heading") {
    return [
      new Paragraph({
        children: renderInlineNodes(node.content ?? []),
        heading: getHeadingLevel(node.attrs?.level),
      }),
    ];
  }

  if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
    return renderList(node);
  }

  if (node.type === "blockquote") {
    return (node.content ?? []).flatMap((child) => {
      if (!isTiptapNode(child)) {
        return [];
      }

      return [
        new Paragraph({
          children: renderInlineNodes(child.content ?? []),
          indent: { left: 360 },
        }),
      ];
    });
  }

  if (node.type === "codeBlock") {
    return [
      new Paragraph({
        children: [new TextRun({ font: "Courier New", text: getNodeText(node) })],
      }),
    ];
  }

  return [
    new Paragraph({
      children: renderInlineNodes(node.content ?? []),
    }),
  ];
}

function renderList(node: TiptapNode): Paragraph[] {
  return (node.content ?? []).flatMap((child) => {
    if (!isTiptapNode(child) || (child.type !== "listItem" && child.type !== "taskItem")) {
      return [];
    }

    const textPrefix = child.type === "taskItem" ? getTaskPrefix(child) : "";
    const children = [...(textPrefix ? [new TextRun(textPrefix)] : []), ...renderInlineNodes(child.content ?? [])];

    return [
      new Paragraph({
        bullet: node.type === "bulletList" || node.type === "taskList" ? { level: 0 } : undefined,
        children: children.length > 0 ? children : [new TextRun("")],
        numbering: node.type === "orderedList" ? { reference: ORDERED_LIST_REFERENCE, level: 0 } : undefined,
      }),
    ];
  });
}

function renderInlineNodes(nodes: unknown[]): DocxInlineNode[] {
  const children = nodes.flatMap((node) => {
    if (!isTiptapNode(node)) {
      return [];
    }

    if (typeof node.text === "string") {
      return [renderTextNode(node)];
    }

    if (node.type === "hardBreak") {
      return [new TextRun({ break: 1 })];
    }

    return renderInlineNodes(node.content ?? []);
  });

  return children.length > 0 ? children : [new TextRun("")];
}

function renderTextNode(node: TiptapNode): DocxInlineNode {
  const marks = node.marks ?? [];
  const link = marks.find((mark) => mark.type === "link" && typeof mark.attrs?.href === "string");
  const textRun = new TextRun({
    bold: marks.some((mark) => mark.type === "bold"),
    italics: marks.some((mark) => mark.type === "italic"),
    strike: marks.some((mark) => mark.type === "strike"),
    style: link ? "Hyperlink" : undefined,
    text: node.text ?? "",
  });

  return link
    ? new ExternalHyperlink({
        children: [textRun],
        link: String(link.attrs?.href),
      })
    : textRun;
}

function getHeadingLevel(level: unknown) {
  if (level === 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  return HeadingLevel.HEADING_4;
}

function getTaskPrefix(node: TiptapNode) {
  return node.attrs?.checked ? "[x] " : "[ ] ";
}

function getNodeText(node: TiptapNode): string {
  if (typeof node.text === "string") {
    return node.text;
  }

  return (node.content ?? []).map((child) => (isTiptapNode(child) ? getNodeText(child) : "")).join("");
}

function isTiptapNode(value: unknown): value is TiptapNode {
  return Boolean(value) && typeof value === "object";
}
