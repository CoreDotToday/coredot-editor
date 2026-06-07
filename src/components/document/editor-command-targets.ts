import type { Editor } from "@tiptap/react";

export type AiCommandScope = "selection" | "currentBlock" | "document";

export type EditorAiCommandTarget = {
  occurrenceIndex: number;
  scope: AiCommandScope;
  selectionRange: { from: number; to: number };
  selectedText: string;
};

export function getEditorAiCommandTarget(
  editor: Editor,
  preferredScope: AiCommandScope | null,
): EditorAiCommandTarget | null {
  return getEditorAiCommandTargetFromTargets(getEditorAiCommandTargets(editor), preferredScope);
}

export function getEditorAiCommandTargetFromTargets(
  targets: EditorAiCommandTarget[],
  preferredScope: AiCommandScope | null,
): EditorAiCommandTarget | null {
  const preferredTarget = targets.find((target) => target.scope === preferredScope);
  return preferredTarget ?? targets[0] ?? null;
}

export function getEditorAiCommandTargets(editor: Editor): EditorAiCommandTarget[] {
  const { doc, selection } = editor.state;
  const selectedText = doc.textBetween(selection.from, selection.to, "\n").trim();
  const targets: EditorAiCommandTarget[] = [];

  if (!selection.empty && selectedText) {
    targets.push({
      occurrenceIndex: countTextOccurrences(doc.textBetween(0, selection.from, "\n"), selectedText),
      scope: "selection",
      selectedText,
      selectionRange: { from: selection.from, to: selection.to },
    });
  }

  const currentBlockTarget = getCurrentBlockCommandTarget(editor);
  if (currentBlockTarget) {
    targets.push(currentBlockTarget);
  }

  const documentText = doc.textBetween(0, doc.content.size, "\n").trim();
  if (documentText) {
    targets.push({
      occurrenceIndex: 0,
      scope: "document",
      selectedText: documentText,
      selectionRange: { from: 0, to: doc.content.size },
    });
  }

  return targets;
}

export function countTextOccurrences(text: string, targetText: string) {
  if (targetText === "") {
    return 0;
  }

  let count = 0;
  let offset = text.indexOf(targetText);

  while (offset !== -1) {
    count += 1;
    offset = text.indexOf(targetText, offset + 1);
  }

  return count;
}

function getCurrentBlockCommandTarget(editor: Editor): EditorAiCommandTarget | null {
  const { doc, selection } = editor.state;
  const { $from } = selection;
  let depth = $from.depth;

  while (depth > 0 && !$from.node(depth).isTextblock) {
    depth -= 1;
  }

  if (depth === 0) {
    return null;
  }

  const from = $from.start(depth);
  const to = $from.end(depth);
  const selectedText = doc.textBetween(from, to, "\n").trim();
  if (!selectedText) {
    return null;
  }

  return {
    occurrenceIndex: countTextOccurrences(doc.textBetween(0, from, "\n"), selectedText),
    scope: "currentBlock",
    selectedText,
    selectionRange: { from, to },
  };
}
