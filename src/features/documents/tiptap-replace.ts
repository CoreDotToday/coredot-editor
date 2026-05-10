import type { TiptapJson } from "@/db/schema";

export type TiptapReplaceResult =
  | { ok: true; contentJson: TiptapJson }
  | { ok: false; reason: "empty_target" | "target_not_found" | "ambiguous_target" };

type TiptapNode = {
  type?: string;
  text?: string;
  content?: unknown[];
  [key: string]: unknown;
};

type TextPiece = {
  contentIndex: number;
  end: number;
  node: TiptapNode & { text: string };
  start: number;
};

export function replaceTextInTiptapJson(
  contentJson: TiptapJson,
  targetText: string,
  replacementText: string,
): TiptapReplaceResult {
  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  const occurrenceCount = countOccurrencesInNode(contentJson, targetText);
  if (occurrenceCount === 0) {
    return { ok: false, reason: "target_not_found" };
  }

  if (occurrenceCount > 1) {
    return { ok: false, reason: "ambiguous_target" };
  }

  const replacement = replaceFirstOccurrenceInNode(contentJson, targetText, replacementText);
  return replacement.replaced
    ? { ok: true, contentJson: replacement.node as TiptapJson }
    : { ok: false, reason: "target_not_found" };
}

export function insertTextBelowTargetInTiptapJson(
  contentJson: TiptapJson,
  targetText: string,
  insertedText: string,
): TiptapReplaceResult {
  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  const occurrenceCount = countOccurrencesInNode(contentJson, targetText);
  if (occurrenceCount === 0) {
    return { ok: false, reason: "target_not_found" };
  }

  if (occurrenceCount > 1) {
    return { ok: false, reason: "ambiguous_target" };
  }

  const insertion = insertBelowFirstContainingBlock(contentJson, targetText, insertedText);
  return insertion.inserted
    ? { ok: true, contentJson: insertion.node as TiptapJson }
    : { ok: false, reason: "target_not_found" };
}

function countOccurrencesInNode(node: TiptapNode, targetText: string) {
  const content = node.content ?? [];
  let count = countOccurrencesInTextRuns(content, targetText);

  for (const child of content) {
    if (isObjectNode(child) && !isTextNode(child)) {
      count += countOccurrencesInNode(child, targetText);
    }
  }

  return count;
}

function countOccurrencesInTextRuns(content: unknown[], targetText: string) {
  let count = 0;
  let runText = "";

  for (const child of content) {
    if (isTextNode(child)) {
      runText += child.text;
      continue;
    }

    count += countOccurrences(runText, targetText);
    runText = "";
  }

  return count + countOccurrences(runText, targetText);
}

function countOccurrences(text: string, targetText: string) {
  let count = 0;
  let offset = text.indexOf(targetText);

  while (offset !== -1) {
    count += 1;
    offset = text.indexOf(targetText, offset + 1);
  }

  return count;
}

function replaceFirstOccurrenceInNode(
  node: TiptapNode,
  targetText: string,
  replacementText: string,
): { node: TiptapNode; replaced: boolean } {
  const content = node.content ?? [];
  const replacedTextRun = replaceFirstOccurrenceInTextRuns(content, targetText, replacementText);
  if (replacedTextRun.replaced) {
    return { node: { ...node, content: replacedTextRun.content }, replaced: true };
  }

  const nextContent: unknown[] = [];
  let replaced = false;

  for (const child of content) {
    if (!replaced && isObjectNode(child) && !isTextNode(child)) {
      const childReplacement = replaceFirstOccurrenceInNode(child, targetText, replacementText);
      nextContent.push(childReplacement.node);
      replaced = childReplacement.replaced;
      continue;
    }

    nextContent.push(child);
  }

  return replaced ? { node: { ...node, content: nextContent }, replaced: true } : { node, replaced: false };
}

function insertBelowFirstContainingBlock(
  node: TiptapNode,
  targetText: string,
  insertedText: string,
): { node: TiptapNode; inserted: boolean } {
  const content = node.content ?? [];
  const nextContent: unknown[] = [];
  let inserted = false;

  for (const child of content) {
    if (!inserted && isObjectNode(child) && !isTextNode(child)) {
      if (isBlockNode(child) && countOccurrencesInNode(child, targetText) === 1) {
        nextContent.push(child, createParagraphNode(insertedText));
        inserted = true;
        continue;
      }

      const childInsertion = insertBelowFirstContainingBlock(child, targetText, insertedText);
      nextContent.push(childInsertion.node);
      inserted = childInsertion.inserted;
      continue;
    }

    nextContent.push(child);
  }

  return inserted ? { node: { ...node, content: nextContent }, inserted: true } : { node, inserted: false };
}

function replaceFirstOccurrenceInTextRuns(
  content: unknown[],
  targetText: string,
  replacementText: string,
): { content: unknown[]; replaced: boolean } {
  let index = 0;

  while (index < content.length) {
    if (!isTextNode(content[index])) {
      index += 1;
      continue;
    }

    const runStart = index;
    const pieces: TextPiece[] = [];
    let runText = "";

    while (index < content.length) {
      const node = content[index];
      if (!isTextNode(node)) {
        break;
      }

      pieces.push({
        contentIndex: index,
        end: runText.length + node.text.length,
        node,
        start: runText.length,
      });
      runText += node.text;
      index += 1;
    }

    const occurrenceStart = runText.indexOf(targetText);
    if (occurrenceStart !== -1) {
      return {
        content: replaceTextRun(content, pieces, occurrenceStart, occurrenceStart + targetText.length, replacementText),
        replaced: true,
      };
    }

    index = Math.max(index, runStart + 1);
  }

  return { content, replaced: false };
}

function replaceTextRun(
  content: unknown[],
  pieces: TextPiece[],
  occurrenceStart: number,
  occurrenceEnd: number,
  replacementText: string,
) {
  const firstPiece = pieces.find((piece) => piece.end > occurrenceStart);
  const lastPiece = pieces.find((piece) => piece.start < occurrenceEnd && piece.end >= occurrenceEnd);

  if (!firstPiece || !lastPiece) {
    return content;
  }

  const prefixText = firstPiece.node.text.slice(0, occurrenceStart - firstPiece.start);
  const suffixText = lastPiece.node.text.slice(occurrenceEnd - lastPiece.start);
  const replacementNodes: unknown[] = [];

  if (prefixText) {
    replacementNodes.push({ ...firstPiece.node, text: prefixText });
  }

  if (replacementText) {
    replacementNodes.push({ ...firstPiece.node, text: replacementText });
  }

  if (suffixText) {
    replacementNodes.push({ ...lastPiece.node, text: suffixText });
  }

  return [
    ...content.slice(0, firstPiece.contentIndex),
    ...replacementNodes,
    ...content.slice(lastPiece.contentIndex + 1),
  ];
}

function isObjectNode(value: unknown): value is TiptapNode {
  return Boolean(value) && typeof value === "object";
}

function isTextNode(value: unknown): value is TiptapNode & { text: string } {
  return isObjectNode(value) && typeof value.text === "string";
}

function isBlockNode(value: TiptapNode) {
  return value.type === "paragraph" || value.type === "heading" || value.type === "blockquote" || value.type === "listItem";
}

function createParagraphNode(text: string): TiptapNode {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
}
