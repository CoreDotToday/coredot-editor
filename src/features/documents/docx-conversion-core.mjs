import { generateJSON } from "@tiptap/html/server";
import { createServerSchemaExtensionsRuntime } from "../../plugins/document-schema-profile-runtime.mjs";
import { appDocumentSchemaProfileRuntime } from "../../plugins/app-document-schema-profile-runtime.mjs";
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
import { normalizeDocxExternalLinkHref } from "./docx-link-policy.mjs";
import { collectDocxSourceFeatures } from "./docx-source-features.mjs";

const ORDERED_LIST_REFERENCE = "coredot-ordered-list";

/** Pure conversion core. Isolation and cancellation are owned by the worker client. */
export async function docxBufferToTiptapJsonCore(buffer) {
  const sourceFeatures = await collectDocxSourceFeatures(buffer);
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(buffer) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        sourceFeatures.add("image");
        const imageBuffer = await image.readAsBase64String();
        return { src: `data:${image.contentType};base64,${imageBuffer}` };
      }),
    },
  );
  const html = result.value.trim() || "<p></p>";
  const contentJson = normalizeTiptapJson(
    generateJSON(html, createServerSchemaExtensionsRuntime(appDocumentSchemaProfileRuntime)),
  );
  return {
    contentJson,
    features: collectDocumentFeatures(contentJson),
    sourceFeatures: [...sourceFeatures],
    warnings: result.messages.map((message) => message.message).filter(Boolean),
  };
}

export async function tiptapJsonToDocxBufferCore(contentJson, title = "Document") {
  const children = renderBlockNodes(contentJson.content ?? [], { nextOrderedListInstance: 0 });
  const document = new Document({
    creator: "Coredot Editor",
    description: "Exported from Coredot Editor",
    numbering: {
      config: [{
        reference: ORDERED_LIST_REFERENCE,
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          style: { paragraph: { indent: { left: 720, hanging: 260 } } },
        }],
      }],
    },
    sections: [{ children: children.length > 0 ? children : [new Paragraph("")] }],
    title,
  });
  return Packer.toBuffer(document);
}

function normalizeTiptapJson(value) {
  return {
    type: "doc",
    content: Array.isArray(value.content) && value.content.length > 0 ? value.content : [{ type: "paragraph" }],
  };
}

function renderBlockNodes(nodes, context) {
  return nodes.flatMap((node) => (isTiptapNode(node) ? renderBlockNode(node, context) : []));
}

function renderBlockNode(node, context) {
  if (node.type === "heading") {
    return [new Paragraph({ children: renderInlineNodes(node.content ?? []), heading: getHeadingLevel(node.attrs?.level) })];
  }
  if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
    return renderList(node, context);
  }
  if (node.type === "blockquote") {
    return (node.content ?? []).flatMap((child) => isTiptapNode(child)
      ? [new Paragraph({ children: renderInlineNodes(child.content ?? []), indent: { left: 360 } })]
      : []);
  }
  if (node.type === "codeBlock") {
    return [new Paragraph({ children: [new TextRun({ font: "Courier New", text: getNodeText(node) })] })];
  }
  return [new Paragraph({ children: renderInlineNodes(node.content ?? []) })];
}

function renderList(node, context) {
  const numberingInstance = node.type === "orderedList" ? context.nextOrderedListInstance++ : undefined;
  return (node.content ?? []).flatMap((child) => {
    if (!isTiptapNode(child) || (child.type !== "listItem" && child.type !== "taskItem")) return [];
    const textPrefix = child.type === "taskItem" ? getTaskPrefix(child) : "";
    const children = [...(textPrefix ? [new TextRun(textPrefix)] : []), ...renderInlineNodes(child.content ?? [])];
    return [new Paragraph({
      bullet: node.type === "bulletList" || node.type === "taskList" ? { level: 0 } : undefined,
      children: children.length > 0 ? children : [new TextRun("")],
      numbering: node.type === "orderedList"
        ? { reference: ORDERED_LIST_REFERENCE, level: 0, instance: numberingInstance }
        : undefined,
    })];
  });
}

function renderInlineNodes(nodes) {
  const children = nodes.flatMap((node) => {
    if (!isTiptapNode(node)) return [];
    if (typeof node.text === "string") return [renderTextNode(node)];
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    return renderInlineNodes(node.content ?? []);
  });
  return children.length > 0 ? children : [new TextRun("")];
}

function renderTextNode(node) {
  const marks = node.marks ?? [];
  const link = marks.find((mark) => mark.type === "link");
  const linkHref = normalizeDocxExternalLinkHref(link?.attrs?.href);
  const textRun = new TextRun({
    bold: marks.some((mark) => mark.type === "bold"),
    italics: marks.some((mark) => mark.type === "italic"),
    strike: marks.some((mark) => mark.type === "strike"),
    style: linkHref ? "Hyperlink" : undefined,
    text: node.text ?? "",
  });
  return linkHref ? new ExternalHyperlink({ children: [textRun], link: linkHref }) : textRun;
}

function getHeadingLevel(level) {
  if (level === 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  return HeadingLevel.HEADING_4;
}

function getTaskPrefix(node) {
  return node.attrs?.checked ? "[x] " : "[ ] ";
}

function getNodeText(node) {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map((child) => (isTiptapNode(child) ? getNodeText(child) : "")).join("");
}

function isTiptapNode(value) {
  return Boolean(value) && typeof value === "object";
}

function collectDocumentFeatures(contentJson) {
  const features = new Set();
  const stack = [contentJson];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isTiptapNode(node) || typeof node.type !== "string") continue;
    if (node.type !== "doc" && node.type !== "text") features.add(node.type);
    if (node.type === "text") {
      if (typeof node.text === "string" && /[\u3131-\u318e\uac00-\ud7a3]/u.test(node.text)) {
        features.add("korean-text");
      }
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (isTiptapNode(mark) && typeof mark.type === "string") features.add(mark.type);
      }
    }
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return [...features];
}
