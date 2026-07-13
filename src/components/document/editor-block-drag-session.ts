import type { TiptapJson } from "@/db/schema";
import { getDocumentBlockSignature } from "@/features/documents/block-movement";
import type { BlockActionRange } from "./editor-block-ranges";

export type EditorBlockDragSession = {
  documentSignature: string;
  source: BlockActionRange;
  sourceText: string;
  sourceType: "listItem" | "topLevel";
};

export function createEditorBlockDragSession(contentJson: TiptapJson, source: BlockActionRange): EditorBlockDragSession {
  return {
    documentSignature: getEditorBlockDocumentSignature(contentJson),
    source,
    sourceText: source.node.textContent.trim().slice(0, 80),
    sourceType: source.kind,
  };
}

export function isEditorBlockDragSessionStale(session: EditorBlockDragSession, contentJson: TiptapJson) {
  return session.documentSignature !== getEditorBlockDocumentSignature(contentJson);
}

export function getEditorBlockDocumentSignature(contentJson: TiptapJson) {
  return getDocumentBlockSignature(contentJson);
}
