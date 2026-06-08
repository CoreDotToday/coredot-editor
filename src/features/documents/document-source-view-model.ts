import type { TiptapJson } from "@/db/schema";
import { extractPlainTextFromTiptap } from "./tiptap-text";

type DocumentSourceSnapshotInput = {
  contentJson: TiptapJson;
  title: string;
};

export type DocumentSourceSnapshot = {
  downloadFileName: string;
  isJsonValid: boolean;
  jsonText: string;
  plainText: string;
};

export function buildDocumentSourceSnapshot({
  contentJson,
  title,
}: DocumentSourceSnapshotInput): DocumentSourceSnapshot {
  const jsonText = JSON.stringify(contentJson, null, 2);

  return {
    downloadFileName: `${sanitizeSourceFileName(title)}.source.json`,
    isJsonValid: isValidJson(jsonText),
    jsonText,
    plainText: extractPlainTextFromTiptap(contentJson),
  };
}

function sanitizeSourceFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "document";
}

function isValidJson(value: string) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
