import type { TiptapJson } from "@/db/schema";
import { normalizeDocxExternalLinkHref } from "@/features/documents/docx-link-policy.mjs";
import {
  docxBufferToTiptapJson,
  tiptapJsonToDocxBuffer,
  type DocxImportResult,
} from "@/features/documents/docx-conversion";
import {
  RESOURCE_LIMITS,
  validateTiptapResource,
  withOperationTimeout,
} from "@/features/security/resource-policy";

export type FidelityItem = {
  feature: string;
  outcome: "approximated" | "preserved" | "removed";
  message?: string;
};

export type FidelityReport = {
  items: FidelityItem[];
  requiresAcknowledgement: boolean;
};

type ImportDocx = (buffer: Buffer, signal?: AbortSignal) => Promise<DocxImportResult>;
type ExportDocx = (contentJson: TiptapJson, title?: string, signal?: AbortSignal) => Promise<Buffer>;

type DocumentInterchangeDependencies = {
  exportDocx?: ExportDocx;
  importDocx?: ImportDocx;
};

type ImportInput = {
  bytes: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type ExportInput = {
  acknowledgedLoss?: boolean;
  contentJson: TiptapJson;
  signal?: AbortSignal;
  timeoutMs?: number;
  title: string;
};

type ResourceLimitResult = { ok: false; reason: "resource_limit" };
type PreviewExportResult =
  | ResourceLimitResult
  | { fidelity: FidelityReport; ok: true };
type ImportResult =
  | ResourceLimitResult
  | {
      contentJson: TiptapJson;
      fidelity: FidelityReport;
      ok: true;
      warnings: string[];
    };
type ExportResult =
  | ResourceLimitResult
  | { fidelity: FidelityReport; ok: false; reason: "acknowledgement_required" }
  | { buffer: Buffer; fidelity: FidelityReport; ok: true };

/**
 * Owns DOCX interchange policy so routes and UI only coordinate HTTP and user
 * acknowledgement. Conversion still happens in the cancellable worker.
 */
export function createDocumentInterchange(dependencies: DocumentInterchangeDependencies = {}) {
  const importDocx = dependencies.importDocx ?? docxBufferToTiptapJson;
  const exportDocx = dependencies.exportDocx ?? tiptapJsonToDocxBuffer;

  async function importDocument(input: ImportInput): Promise<ImportResult> {
    if (input.bytes.byteLength > RESOURCE_LIMITS.docxBytes) {
      return { ok: false, reason: "resource_limit" };
    }

    const conversion = await withOperationTimeout(
      (signal) => importDocx(Buffer.from(input.bytes), signal),
      input.timeoutMs,
      input.signal,
    );
    if (!validateTiptapResource(conversion.contentJson).ok) {
      return { ok: false, reason: "resource_limit" };
    }

    return {
      contentJson: conversion.contentJson,
      fidelity: createImportFidelityReport(conversion),
      ok: true,
      warnings: conversion.warnings,
    };
  }

  async function previewExport(contentJson: TiptapJson): Promise<PreviewExportResult> {
    if (!validateTiptapResource(contentJson).ok) {
      return { ok: false, reason: "resource_limit" };
    }

    return { fidelity: classifyDocxExportFidelity(contentJson), ok: true };
  }

  async function exportDocument(input: ExportInput): Promise<ExportResult> {
    const preview = await previewExport(input.contentJson);
    if (!preview.ok) return preview;
    if (preview.fidelity.requiresAcknowledgement && !input.acknowledgedLoss) {
      return {
        fidelity: preview.fidelity,
        ok: false,
        reason: "acknowledgement_required",
      };
    }

    const buffer = await withOperationTimeout(
      (signal) => exportDocx(input.contentJson, input.title, signal),
      input.timeoutMs,
      input.signal,
    );
    return { buffer, fidelity: preview.fidelity, ok: true };
  }

  return {
    export: exportDocument,
    import: importDocument,
    previewExport,
  };
}

export const documentInterchange = createDocumentInterchange();

function createImportFidelityReport(conversion: DocxImportResult): FidelityReport {
  const convertedFeatures = normalizeImportedFeatures(
    conversion.features ?? collectImportedFeatures(conversion.contentJson),
  );
  const sourceFeatures = normalizeImportedFeatures(conversion.sourceFeatures);
  const convertedFeatureSet = new Set(convertedFeatures);
  const items: FidelityItem[] = convertedFeatures
    .map((feature) => ({ feature, outcome: "preserved" }));
  items.push({ feature: "docx-formatting", outcome: "approximated" });
  items.push(...sourceFeatures
    .filter((feature) => !convertedFeatureSet.has(feature))
    .map((feature) => ({ feature, outcome: "removed" as const })));
  items.push(...conversion.warnings.map((message) => ({
    feature: "conversion-warning",
    message,
    outcome: classifyImportWarning(message),
  })));
  return createFidelityReport(items);
}

function normalizeImportedFeatures(features: readonly string[]) {
  const normalized = new Set<string>();
  for (const feature of features) {
    if (DOCX_IMPORT_STRUCTURAL_FEATURES.has(feature)) continue;
    normalized.add(DOCX_IMPORT_FEATURE_ALIASES[feature] ?? feature);
  }
  return [...normalized];
}

function classifyImportWarning(message: string): FidelityItem["outcome"] {
  return /\b(ignore[ds]?|not supported|unrecognis(?:ed|able)|unrecogniz(?:ed|able)|unsupported)\b/i.test(message)
    ? "removed"
    : "approximated";
}

/** Mirrors the behavior implemented by docx-conversion-core.mjs. */
function classifyDocxExportFidelity(contentJson: TiptapJson): FidelityReport {
  const items: FidelityItem[] = [];
  const stack: Array<{ listDepth: number; node: Record<string, unknown> }> = [
    { listDepth: 0, node: contentJson },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const type = String(current.node.type);
    const isList = type === "bulletList" || type === "orderedList" || type === "taskList";
    const content = Array.isArray(current.node.content) ? current.node.content : [];

    if (type === "paragraph") addItem(items, "paragraph", "preserved");
    else if (type === "heading") {
      const level = readNumericAttribute(current.node, "level");
      addItem(items, "heading", level >= 1 && level <= 4 ? "preserved" : "approximated");
    } else if (type === "bulletList" || type === "orderedList") {
      addItem(items, "list", "preserved");
      if (current.listDepth > 0) addItem(items, "nested-list", "approximated");
      if (type === "orderedList") {
        const start = readNumericAttribute(current.node, "start");
        if (Number.isFinite(start) && start !== 1) addItem(items, "ordered-list-start", "approximated");
      }
    } else if (type === "taskList" || type === "taskItem") {
      addItem(items, "task-list", "approximated");
      if (type === "taskList" && current.listDepth > 0) addItem(items, "nested-list", "approximated");
    } else if (type === "listItem" && content.length > 1) {
      addItem(items, "multi-block-list-item", "approximated");
    } else if (type === "blockquote") addItem(items, "blockquote", "approximated");
    else if (type === "codeBlock") addItem(items, "code-block", "approximated");
    else if (type === "hardBreak") addItem(items, "hard-break", "preserved");
    else if (type === "horizontalRule") addItem(items, "horizontal-rule", "removed");
    else if (type === "table") addItem(items, "table", "approximated");
    else if (type === "text") classifyTextNode(current.node, items);
    else if (!DOCX_STRUCTURAL_NODE_TYPES.has(type)) {
      addItem(
        items,
        `unknown:${type}`,
        hasTextualContent(current.node) ? "approximated" : "removed",
      );
    }

    const childListDepth = current.listDepth + (isList ? 1 : 0);
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const child = content[index];
      if (isRecord(child)) stack.push({ listDepth: childListDepth, node: child });
    }
  }

  return createFidelityReport(items);
}

function classifyTextNode(node: Record<string, unknown>, items: FidelityItem[]) {
  if (typeof node.text === "string" && KOREAN_TEXT_PATTERN.test(node.text)) {
    addItem(items, "korean-text", "preserved");
  }
  const marks = Array.isArray(node.marks) ? node.marks : [];
  for (const mark of marks) {
    if (!isRecord(mark) || typeof mark.type !== "string") continue;
    if (mark.type === "link") {
      const attrs = isRecord(mark.attrs) ? mark.attrs : {};
      addItem(items, "link", normalizeDocxExternalLinkHref(attrs.href) ? "preserved" : "removed");
    } else if (PRESERVED_MARKS.has(mark.type)) addItem(items, mark.type, "preserved");
    else addItem(items, `mark:${mark.type}`, "removed");
  }
}

function collectImportedFeatures(contentJson: TiptapJson) {
  const features = new Set<string>();
  const stack: unknown[] = [contentJson];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || typeof node.type !== "string") continue;
    if (node.type !== "doc" && node.type !== "text") features.add(node.type);
    if (node.type === "text") {
      if (typeof node.text === "string" && KOREAN_TEXT_PATTERN.test(node.text)) features.add("korean-text");
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (isRecord(mark) && typeof mark.type === "string") features.add(mark.type);
      }
    }
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return [...features];
}

function createFidelityReport(items: FidelityItem[]): FidelityReport {
  const uniqueItems = [...new Map(items.map((item) => [
    `${item.feature}\u0000${item.outcome}\u0000${item.message ?? ""}`,
    item,
  ])).values()];
  return {
    items: uniqueItems,
    requiresAcknowledgement: uniqueItems.some((item) => item.outcome !== "preserved"),
  };
}

function addItem(items: FidelityItem[], feature: string, outcome: FidelityItem["outcome"]) {
  items.push({ feature, outcome });
}

function hasTextualContent(root: Record<string, unknown>) {
  const stack: unknown[] = [...(Array.isArray(root.content) ? root.content : [])];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!isRecord(value)) continue;
    if (typeof value.text === "string" && value.text.length > 0) return true;
    if (value.type === "hardBreak") return true;
    if (Array.isArray(value.content)) stack.push(...value.content);
  }
  return false;
}

function readNumericAttribute(node: Record<string, unknown>, name: string) {
  return isRecord(node.attrs) && typeof node.attrs[name] === "number" ? node.attrs[name] : Number.NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const DOCX_STRUCTURAL_NODE_TYPES = new Set(["doc", "listItem", "tableCell", "tableHeader", "tableRow"]);
const PRESERVED_MARKS = new Set(["bold", "italic", "strike"]);
const DOCX_IMPORT_STRUCTURAL_FEATURES = new Set([
  "doc",
  "listItem",
  "tableCell",
  "tableHeader",
  "tableRow",
  "taskItem",
  "text",
]);
const DOCX_IMPORT_FEATURE_ALIASES: Readonly<Record<string, string>> = {
  bulletList: "list",
  codeBlock: "code-block",
  hardBreak: "hard-break",
  horizontalRule: "horizontal-rule",
  orderedList: "list",
  taskList: "task-list",
};
const KOREAN_TEXT_PATTERN = /[\u3131-\u318e\uac00-\ud7a3]/u;
