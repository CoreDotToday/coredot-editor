import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";

import type { TiptapJson } from "@/db/schema";
import {
  createDocumentBlockLocation,
  moveDocumentBlock,
  type DocumentBlockDestination,
  type DocumentBlockMoveIntent,
} from "@/features/documents/block-movement";
import {
  clamp,
  getListItemOwnIndex,
  getListItemParentPath,
  type BlockActionRange,
  type RuntimeEditor,
} from "./editor-block-ranges";

export function applyScopedBlockMove(
  editor: RuntimeEditor,
  intent: DocumentBlockMoveIntent,
): DocumentBlockDestination | null {
  // Y.XmlFragment has no identity-preserving move primitive. A ProseMirror
  // delete+insert copies the node and can attach concurrent source edits to a
  // different block. Keep the legacy planner, but fail closed for Yjs bodies.
  if (isCollaborationEditor(editor)) return null;
  const result = moveDocumentBlock(editor.getJSON() as TiptapJson, intent);
  if (!result.changed) return null;
  if (intent.source.kind === "topLevel" && result.destination.kind === "topLevel") {
    return applyTopLevelBlockMove(
      editor,
      intent.source.path[0],
      result.destination.path[0],
    )
      ? result.destination
      : null;
  }
  return applyScopedDocumentJson(editor, result.contentJson) ? result.destination : null;
}

function applyTopLevelBlockMove(
  editor: RuntimeEditor,
  sourceIndex: number,
  destinationIndex: number,
) {
  const sourceNode = editor.state.doc.child(sourceIndex);
  let sourceFrom = 0;
  for (let index = 0; index < sourceIndex; index += 1) {
    sourceFrom += editor.state.doc.child(index).nodeSize;
  }

  const transaction = editor.state.tr.delete(sourceFrom, sourceFrom + sourceNode.nodeSize);
  let insertAt = 0;
  for (let index = 0; index < destinationIndex; index += 1) {
    insertAt += transaction.doc.child(index).nodeSize;
  }
  transaction.insert(insertAt, sourceNode);
  editor.view.dispatch(transaction);
  return true;
}

export function applyScopedLastBlockDeletion(
  editor: RuntimeEditor,
  range: BlockActionRange,
  collaborationDocument?: Y.Doc | null,
) {
  if (range.kind !== "topLevel" || editor.state.doc.childCount !== 1) return false;
  if (collaborationDocument) {
    // Atom/container blocks need schema-aware replacement. Acknowledging their
    // deletion without changing Yjs would mislead the UI, so defer them until
    // an identity-preserving structural transaction exists.
    if (!range.node.isTextblock) return false;
    const block = collaborationDocument.getXmlFragment("body").get(range.topLevelIndex);
    if (!(block instanceof Y.XmlFragment)) return false;
    let changed = false;
    collaborationDocument.transact(() => {
      for (let index = block.length - 1; index >= 0; index -= 1) {
        const inline = block.get(index);
        if (inline instanceof Y.XmlText) {
          if (inline.length === 0) continue;
          inline.delete(0, inline.length);
        } else {
          block.delete(index, 1);
        }
        changed = true;
      }
    });
    return changed;
  }
  const contentFrom = Math.min(range.to - 1, range.from + 1);
  const contentTo = Math.max(contentFrom, range.to - 1);
  const transaction = editor.state.tr.delete(contentFrom, contentTo);
  editor.view.dispatch(transaction);
  return true;
}

export function applyScopedListItemConversion(
  editor: RuntimeEditor,
  range: BlockActionRange,
): DocumentBlockDestination | null {
  if (isCollaborationEditor(editor)) return null;
  if (range.kind !== "listItem") return null;
  const sourceIndex = getListItemOwnIndex(range);
  const parentPath = getListItemParentPath(range);
  if (typeof sourceIndex !== "number" || parentPath.length > 0) return null;

  const selectionPosition = clamp(
    range.from + 2,
    1,
    Math.max(1, Math.min(range.to - 1, editor.state.doc.content.size)),
  );
  const changed = editor
    .chain()
    .setTextSelection(selectionPosition)
    .liftListItem(range.node.type.name)
    .run();
  if (!changed) return null;
  return {
    kind: "topLevel",
    path: [range.topLevelIndex + (sourceIndex > 0 ? 1 : 0)],
  };
}

export function applyScopedOutdent(
  editor: RuntimeEditor,
  range: BlockActionRange,
): DocumentBlockDestination | null {
  if (isCollaborationEditor(editor)) return null;
  const source = createDocumentBlockLocation(range);
  if (source?.kind !== "listItem") return null;
  const selectionPosition = clamp(
    range.from + 2,
    1,
    Math.max(1, Math.min(range.to - 1, editor.state.doc.content.size)),
  );
  const changed = editor
    .chain()
    .setTextSelection(selectionPosition)
    .liftListItem(range.node.type.name)
    .run();
  if (!changed) return null;

  return source;
}

/**
 * Converts a legacy JSON planning result into one ProseMirror replacement over
 * the smallest differing range. Collaborative bodies fail closed because a
 * delete+insert replacement cannot preserve Yjs node identity.
 */
export function applyScopedDocumentJson(editor: RuntimeEditor, contentJson: TiptapJson) {
  if (isCollaborationEditor(editor)) return false;
  const currentDocument = editor.state.doc;
  const nextDocument = editor.state.schema.nodeFromJSON(contentJson as JSONContent);
  const start = currentDocument.content.findDiffStart(nextDocument.content);
  if (start === null) return false;

  const end = currentDocument.content.findDiffEnd(nextDocument.content);
  const currentEnd = end?.a ?? currentDocument.content.size;
  const nextEnd = end?.b ?? nextDocument.content.size;
  const transaction = editor.state.tr.replace(
    start,
    currentEnd,
    nextDocument.slice(start, nextEnd),
  );
  editor.view.dispatch(transaction);
  return true;
}

function isCollaborationEditor(editor: RuntimeEditor) {
  return editor.extensionManager.extensions.some((extension) => extension.name === "collaboration");
}
