import type { TiptapJson } from "@/db/schema";

export type TiptapReplaceResult =
  | { ok: true; contentJson: TiptapJson }
  | { ok: false; reason: "empty_target" | "target_not_found" | "ambiguous_target" | "stale_selection" };

type TiptapReplaceOptions = {
  occurrenceIndex?: number;
  requireSelectionRangeMatch?: boolean;
  selectionRange?: {
    from: number;
    to: number;
  };
};

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

type ListItemRange = {
  itemIndex: number;
  listPath: number[];
  node: TiptapNode;
  text: string;
  textEnd: number;
  textStart: number;
};

type TextExtent = {
  end: number;
  start: number;
};

type TextRangeMatch =
  | {
      kind: "block";
      prefixText: string;
      ranges: TopLevelBlockRange[];
      suffixText: string;
      start: number;
    }
  | {
      kind: "list";
      ranges: ListItemRange[];
      start: number;
    };

export function replaceTextInTiptapJson(
  contentJson: TiptapJson,
  targetText: string,
  replacementText: string,
  options: TiptapReplaceOptions = {},
): TiptapReplaceResult {
  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  if (options.selectionRange) {
    const rangeReplacement = replaceSelectionRange(contentJson, targetText, replacementText, options.selectionRange);
    if (rangeReplacement.ok) {
      return rangeReplacement;
    }

    if (options.requireSelectionRangeMatch) {
      return { ok: false, reason: "stale_selection" };
    }
  }

  const occurrenceCount = countOccurrencesInNode(contentJson, targetText);
  if (occurrenceCount === 0) {
    return replaceMatchedTextRange(contentJson, targetText, replacementText, options.occurrenceIndex);
  }

  if (options.occurrenceIndex !== undefined) {
    if (options.occurrenceIndex < 0 || options.occurrenceIndex >= occurrenceCount) {
      return { ok: false, reason: "target_not_found" };
    }

    const replacement = replaceOccurrenceInNode(contentJson, targetText, replacementText, {
      remaining: options.occurrenceIndex,
    });
    return replacement.replaced
      ? { ok: true, contentJson: replacement.node as TiptapJson }
      : { ok: false, reason: "target_not_found" };
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
  options: TiptapReplaceOptions = {},
): TiptapReplaceResult {
  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  if (options.selectionRange) {
    const rangeInsertion = insertBelowSelectionRange(contentJson, targetText, insertedText, options.selectionRange);
    if (rangeInsertion.ok) {
      return rangeInsertion;
    }

    if (options.requireSelectionRangeMatch) {
      return { ok: false, reason: "stale_selection" };
    }
  }

  const occurrenceCount = countOccurrencesInNode(contentJson, targetText);
  if (occurrenceCount === 0) {
    return insertBelowMatchedTextRange(contentJson, targetText, insertedText, options.occurrenceIndex);
  }

  if (options.occurrenceIndex !== undefined) {
    if (options.occurrenceIndex < 0 || options.occurrenceIndex >= occurrenceCount) {
      return { ok: false, reason: "target_not_found" };
    }

    const insertion = insertBelowOccurrenceBlock(contentJson, targetText, insertedText, {
      remaining: options.occurrenceIndex,
    });
    return insertion.inserted
      ? { ok: true, contentJson: insertion.node as TiptapJson }
      : { ok: false, reason: "target_not_found" };
  }

  if (occurrenceCount > 1) {
    return { ok: false, reason: "ambiguous_target" };
  }

  const insertion = insertBelowFirstContainingBlock(contentJson, targetText, insertedText);
  return insertion.inserted
    ? { ok: true, contentJson: insertion.node as TiptapJson }
    : { ok: false, reason: "target_not_found" };
}

function replaceSelectionRange(
  contentJson: TiptapJson,
  targetText: string,
  replacementText: string,
  selectionRange: { from: number; to: number },
): TiptapReplaceResult {
  const listReplacement = replaceListItemSelectionRange(contentJson, targetText, replacementText, selectionRange);
  if (listReplacement.ok) {
    return listReplacement;
  }

  const blockRanges = getTopLevelBlockRanges(contentJson);
  const selectedBlockRanges = getSelectedBlockRanges(blockRanges, selectionRange);
  if (selectedBlockRanges.length === 0 || !doesRangeMatchTarget(selectedBlockRanges, selectionRange, targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  const firstRange = selectedBlockRanges[0]!;
  const lastRange = selectedBlockRanges[selectedBlockRanges.length - 1]!;
  const firstText = getNodeText(firstRange.node);
  const lastText = getNodeText(lastRange.node);
  const prefixText = firstText.slice(0, clamp(selectionRange.from - firstRange.textStart, 0, firstText.length));
  const suffixText = lastText.slice(clamp(selectionRange.to - lastRange.textStart, 0, lastText.length));
  const replacementBlock = createSelectionReplacementBlock(firstRange.node, `${prefixText}${replacementText}${suffixText}`);
  const content = contentJson.content ?? [];

  return {
    ok: true,
    contentJson: {
      ...contentJson,
      content: [
        ...content.slice(0, firstRange.index),
        replacementBlock,
        ...content.slice(lastRange.index + 1),
      ],
    },
  };
}

function insertBelowSelectionRange(
  contentJson: TiptapJson,
  targetText: string,
  insertedText: string,
  selectionRange: { from: number; to: number },
): TiptapReplaceResult {
  const listInsertion = insertBelowListItemSelectionRange(contentJson, targetText, insertedText, selectionRange);
  if (listInsertion.ok) {
    return listInsertion;
  }

  const blockRanges = getTopLevelBlockRanges(contentJson);
  const selectedBlockRanges = getSelectedBlockRanges(blockRanges, selectionRange);
  if (selectedBlockRanges.length === 0 || !doesRangeMatchTarget(selectedBlockRanges, selectionRange, targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  const lastRange = selectedBlockRanges[selectedBlockRanges.length - 1]!;
  const content = contentJson.content ?? [];

  return {
    ok: true,
    contentJson: {
      ...contentJson,
      content: [
        ...content.slice(0, lastRange.index + 1),
        createParagraphNode(insertedText),
        ...content.slice(lastRange.index + 1),
      ],
    },
  };
}

function replaceMatchedTextRange(
  contentJson: TiptapJson,
  targetText: string,
  replacementText: string,
  occurrenceIndex: number | undefined,
): TiptapReplaceResult {
  const matchResult = getTextRangeMatch(contentJson, targetText, occurrenceIndex);
  if (!matchResult.ok) {
    return matchResult;
  }

  const match = matchResult.match;
  if (match.kind === "list") {
    const firstRange = match.ranges[0]!;
    const lastRange = match.ranges[match.ranges.length - 1]!;
    const replacementItems = createListItemNodes(replacementText, firstRange.node);
    const nextContentJson = updateNodeAtPath(contentJson, firstRange.listPath, (listNode) => ({
      ...listNode,
      content: [
        ...(listNode.content ?? []).slice(0, firstRange.itemIndex),
        ...replacementItems,
        ...(listNode.content ?? []).slice(lastRange.itemIndex + 1),
      ],
    }));

    return { ok: true, contentJson: nextContentJson as TiptapJson };
  }

  const firstRange = match.ranges[0]!;
  const lastRange = match.ranges[match.ranges.length - 1]!;
  const content = contentJson.content ?? [];

  return {
    ok: true,
    contentJson: {
      ...contentJson,
      content: [
        ...content.slice(0, firstRange.index),
        createSelectionReplacementBlock(firstRange.node, `${match.prefixText}${replacementText}${match.suffixText}`),
        ...content.slice(lastRange.index + 1),
      ],
    },
  };
}

function insertBelowMatchedTextRange(
  contentJson: TiptapJson,
  targetText: string,
  insertedText: string,
  occurrenceIndex: number | undefined,
): TiptapReplaceResult {
  const matchResult = getTextRangeMatch(contentJson, targetText, occurrenceIndex);
  if (!matchResult.ok) {
    return matchResult;
  }

  const match = matchResult.match;
  if (match.kind === "list") {
    const lastRange = match.ranges[match.ranges.length - 1]!;
    const insertedItems = createListItemNodes(insertedText, lastRange.node);
    const nextContentJson = updateNodeAtPath(contentJson, lastRange.listPath, (listNode) => ({
      ...listNode,
      content: [
        ...(listNode.content ?? []).slice(0, lastRange.itemIndex + 1),
        ...insertedItems,
        ...(listNode.content ?? []).slice(lastRange.itemIndex + 1),
      ],
    }));

    return { ok: true, contentJson: nextContentJson as TiptapJson };
  }

  const lastRange = match.ranges[match.ranges.length - 1]!;
  const content = contentJson.content ?? [];

  return {
    ok: true,
    contentJson: {
      ...contentJson,
      content: [
        ...content.slice(0, lastRange.index + 1),
        createParagraphNode(insertedText),
        ...content.slice(lastRange.index + 1),
      ],
    },
  };
}

function getTextRangeMatch(
  contentJson: TiptapJson,
  targetText: string,
  occurrenceIndex: number | undefined,
): { ok: true; match: TextRangeMatch } | { ok: false; reason: "target_not_found" | "ambiguous_target" } {
  const matches = findTextRangeMatches(contentJson, targetText);
  if (matches.length === 0) {
    return { ok: false, reason: "target_not_found" };
  }

  if (occurrenceIndex !== undefined) {
    const match = matches[occurrenceIndex];
    return match ? { ok: true, match } : { ok: false, reason: "target_not_found" };
  }

  return matches.length === 1 ? { ok: true, match: matches[0]! } : { ok: false, reason: "ambiguous_target" };
}

function findTextRangeMatches(contentJson: TiptapJson, targetText: string): TextRangeMatch[] {
  const targetLineText = normalizeLineText(targetText);
  if (!targetLineText.includes("\n")) {
    return [];
  }

  return [
    ...findTopLevelBlockTextRangeMatches(contentJson, targetLineText),
    ...findListItemTextRangeMatches(contentJson, targetLineText),
  ].sort((left, right) => left.start - right.start);
}

function findTopLevelBlockTextRangeMatches(contentJson: TiptapJson, targetLineText: string): TextRangeMatch[] {
  const ranges = getTopLevelBlockRanges(contentJson);
  const matches: TextRangeMatch[] = [];

  for (let startIndex = 0; startIndex < ranges.length; startIndex += 1) {
    const selectedRanges: TopLevelBlockRange[] = [];
    for (let endIndex = startIndex; endIndex < ranges.length; endIndex += 1) {
      selectedRanges.push(ranges[endIndex]!);
      const match = createTopLevelBlockTextRangeMatch(selectedRanges, targetLineText);
      if (match && !isSingleTopLevelListMatch(selectedRanges)) {
        matches.push(match);
      }
    }
  }

  return matches;
}

function createTopLevelBlockTextRangeMatch(
  selectedRanges: TopLevelBlockRange[],
  targetLineText: string,
): TextRangeMatch | null {
  const selectedTexts = selectedRanges.map((range) => getNodeText(range.node));
  if (normalizeLineText(selectedTexts.join("\n")) === targetLineText) {
    return {
      kind: "block",
      prefixText: "",
      ranges: [...selectedRanges],
      start: selectedRanges[0]!.textStart,
      suffixText: "",
    };
  }

  const targetLines = targetLineText.split("\n");
  if (selectedRanges.length < 2 || selectedTexts.length !== targetLines.length) {
    return null;
  }

  const firstText = selectedTexts[0]!;
  const lastText = selectedTexts[selectedTexts.length - 1]!;
  const firstTargetLine = targetLines[0]!;
  const lastTargetLine = targetLines[targetLines.length - 1]!;
  const middleTexts = selectedTexts.slice(1, -1).map(normalizeLineText);
  const middleTargetLines = targetLines.slice(1, -1);

  if (
    !firstText.endsWith(firstTargetLine) ||
    !lastText.startsWith(lastTargetLine) ||
    !middleTexts.every((middleText, index) => middleText === middleTargetLines[index])
  ) {
    return null;
  }

  return {
    kind: "block",
    prefixText: firstText.slice(0, firstText.length - firstTargetLine.length),
    ranges: [...selectedRanges],
    start: selectedRanges[0]!.textStart,
    suffixText: lastText.slice(lastTargetLine.length),
  };
}

function findListItemTextRangeMatches(contentJson: TiptapJson, targetLineText: string): TextRangeMatch[] {
  const ranges = getListItemRanges(contentJson);
  const matches: TextRangeMatch[] = [];

  for (let startIndex = 0; startIndex < ranges.length; startIndex += 1) {
    const selectedRanges: ListItemRange[] = [];
    const firstRange = ranges[startIndex]!;
    for (let endIndex = startIndex; endIndex < ranges.length; endIndex += 1) {
      const range = ranges[endIndex]!;
      const previousRange = selectedRanges[selectedRanges.length - 1];
      if (
        !arraysEqual(range.listPath, firstRange.listPath) ||
        (previousRange && range.itemIndex !== previousRange.itemIndex + 1)
      ) {
        break;
      }

      selectedRanges.push(range);
      if (normalizeLineText(selectedRanges.map((selectedRange) => selectedRange.text).join("\n")) === targetLineText) {
        matches.push({
          kind: "list",
          ranges: [...selectedRanges],
          start: selectedRanges[0]!.textStart,
        });
      }
    }
  }

  return matches;
}

function replaceListItemSelectionRange(
  contentJson: TiptapJson,
  targetText: string,
  replacementText: string,
  selectionRange: { from: number; to: number },
): TiptapReplaceResult {
  const selectedRanges = getSelectedListItemRanges(contentJson, selectionRange);
  if (!isContiguousListSelection(selectedRanges) || !doesListRangeMatchTarget(selectedRanges, targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  const firstRange = selectedRanges[0]!;
  const lastRange = selectedRanges[selectedRanges.length - 1]!;
  const replacementItems = createListItemNodes(replacementText, firstRange.node);
  const nextContentJson = updateNodeAtPath(contentJson, firstRange.listPath, (listNode) => ({
    ...listNode,
    content: [
      ...(listNode.content ?? []).slice(0, firstRange.itemIndex),
      ...replacementItems,
      ...(listNode.content ?? []).slice(lastRange.itemIndex + 1),
    ],
  }));

  return { ok: true, contentJson: nextContentJson as TiptapJson };
}

function insertBelowListItemSelectionRange(
  contentJson: TiptapJson,
  targetText: string,
  insertedText: string,
  selectionRange: { from: number; to: number },
): TiptapReplaceResult {
  const selectedRanges = getSelectedListItemRanges(contentJson, selectionRange);
  if (!isContiguousListSelection(selectedRanges) || !doesListRangeMatchTarget(selectedRanges, targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  const firstRange = selectedRanges[0]!;
  const lastRange = selectedRanges[selectedRanges.length - 1]!;
  const insertedItems = createListItemNodes(insertedText, lastRange.node);
  const nextContentJson = updateNodeAtPath(contentJson, firstRange.listPath, (listNode) => ({
    ...listNode,
    content: [
      ...(listNode.content ?? []).slice(0, lastRange.itemIndex + 1),
      ...insertedItems,
      ...(listNode.content ?? []).slice(lastRange.itemIndex + 1),
    ],
  }));

  return { ok: true, contentJson: nextContentJson as TiptapJson };
}

type TopLevelBlockRange = {
  index: number;
  node: TiptapNode;
  textEnd: number;
  textStart: number;
};

function getTopLevelBlockRanges(contentJson: TiptapJson) {
  const content = contentJson.content ?? [];
  const ranges: TopLevelBlockRange[] = [];
  let position = 0;

  content.forEach((child, index) => {
    if (!isObjectNode(child) || (!isBlockNode(child) && !isListNode(child))) {
      position += getNodeSize(child);
      return;
    }

    const nodeSize = getNodeSize(child);
    const textExtent = getTextExtent(child, position);
    if (!textExtent) {
      position += nodeSize;
      return;
    }

    ranges.push({
      index,
      node: child,
      textStart: textExtent.start,
      textEnd: textExtent.end,
    });
    position += nodeSize;
  });

  return ranges;
}

function getSelectedBlockRanges(blockRanges: TopLevelBlockRange[], selectionRange: { from: number; to: number }) {
  return blockRanges.filter((blockRange) => selectionRange.from < blockRange.textEnd && selectionRange.to > blockRange.textStart);
}

function doesRangeMatchTarget(
  selectedBlockRanges: TopLevelBlockRange[],
  selectionRange: { from: number; to: number },
  targetText: string,
) {
  const selectedText = selectedBlockRanges
    .map((blockRange) => {
      const text = getNodeText(blockRange.node);
      const start = clamp(selectionRange.from - blockRange.textStart, 0, text.length);
      const end = clamp(selectionRange.to - blockRange.textStart, 0, text.length);
      return text.slice(start, end);
    })
    .filter(Boolean)
    .join("\n");

  return normalizeLineText(selectedText) === normalizeLineText(targetText) || normalizeLooseText(selectedText) === normalizeLooseText(targetText);
}

function getSelectedListItemRanges(contentJson: TiptapJson, selectionRange: { from: number; to: number }) {
  return getListItemRanges(contentJson).filter(
    (range) => selectionRange.from < range.textEnd && selectionRange.to > range.textStart,
  );
}

function getListItemRanges(contentJson: TiptapJson) {
  const ranges: ListItemRange[] = [];

  visitNodeWithPositions(contentJson, 0, [], (node, nodeStart, path) => {
    if (!isListNode(node)) {
      return;
    }

    let itemStart = nodeStart + 1;
    (node.content ?? []).forEach((child, itemIndex) => {
      if (isObjectNode(child) && isListItemNode(child)) {
        const extent = getDirectListItemTextExtent(child, itemStart);
        const text = getDirectListItemText(child);

        if (extent && text.trim()) {
          ranges.push({
            itemIndex,
            listPath: path,
            node: child,
            text,
            textEnd: extent.end,
            textStart: extent.start,
          });
        }
      }

      itemStart += getNodeSize(child);
    });
  });

  return ranges;
}

function visitNodeWithPositions(
  node: TiptapNode,
  nodeStart: number,
  path: number[],
  visitor: (node: TiptapNode, nodeStart: number, path: number[]) => void,
) {
  visitor(node, nodeStart, path);

  const content = node.content ?? [];
  let childStart = node.type === "doc" ? 0 : nodeStart + 1;
  content.forEach((child, index) => {
    if (isObjectNode(child)) {
      visitNodeWithPositions(child, childStart, [...path, index], visitor);
    }

    childStart += getNodeSize(child);
  });
}

function getDirectListItemTextExtent(node: TiptapNode, nodeStart: number): TextExtent | null {
  const content = node.content ?? [];
  let childStart = nodeStart + 1;
  let start: number | null = null;
  let end: number | null = null;

  for (const child of content) {
    if (isObjectNode(child) && !isListNode(child)) {
      const childExtent = getTextExtent(child, childStart);
      if (childExtent) {
        start = start === null ? childExtent.start : Math.min(start, childExtent.start);
        end = end === null ? childExtent.end : Math.max(end, childExtent.end);
      }
    }

    childStart += getNodeSize(child);
  }

  return start === null || end === null ? null : { start, end };
}

function getTextExtent(node: TiptapNode, nodeStart: number): TextExtent | null {
  if (isTextNode(node)) {
    return { start: nodeStart, end: nodeStart + node.text.length };
  }

  const content = node.content ?? [];
  let childStart = node.type === "doc" ? 0 : nodeStart + 1;
  let start: number | null = null;
  let end: number | null = null;

  for (const child of content) {
    if (isObjectNode(child)) {
      const childExtent = getTextExtent(child, childStart);
      if (childExtent) {
        start = start === null ? childExtent.start : Math.min(start, childExtent.start);
        end = end === null ? childExtent.end : Math.max(end, childExtent.end);
      }
    }

    childStart += getNodeSize(child);
  }

  return start === null || end === null ? null : { start, end };
}

function isContiguousListSelection(selectedRanges: ListItemRange[]) {
  if (selectedRanges.length === 0) {
    return false;
  }

  const firstRange = selectedRanges[0]!;
  return selectedRanges.every((range, index) => {
    const previousRange = selectedRanges[index - 1];
    return (
      arraysEqual(range.listPath, firstRange.listPath) &&
      (!previousRange || range.itemIndex === previousRange.itemIndex + 1)
    );
  });
}

function doesListRangeMatchTarget(selectedRanges: ListItemRange[], targetText: string) {
  const selectedText = selectedRanges.map((range) => range.text).join("\n");
  return normalizeLineText(selectedText) === normalizeLineText(targetText) || normalizeLooseText(selectedText) === normalizeLooseText(targetText);
}

function updateNodeAtPath(node: TiptapNode, path: number[], updater: (node: TiptapNode) => TiptapNode): TiptapNode {
  if (path.length === 0) {
    return updater(node);
  }

  const [index, ...remainingPath] = path;
  const content = node.content ?? [];
  return {
    ...node,
    content: content.map((child, childIndex) =>
      childIndex === index && isObjectNode(child) ? updateNodeAtPath(child, remainingPath, updater) : child,
    ),
  };
}

function createListItemNodes(text: string, templateItem: TiptapNode) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLines = lines.length > 0 ? lines : [""];
  const itemType = templateItem.type === "taskItem" ? "taskItem" : "listItem";
  const templateAttrs = isObjectRecord(templateItem.attrs) ? templateItem.attrs : {};
  const attrs = itemType === "taskItem" ? { ...templateAttrs, checked: false } : { ...templateAttrs };

  return normalizedLines.map((line) => ({
    type: itemType,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: [createParagraphNode(line)],
  }));
}

function arraysEqual(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSingleTopLevelListMatch(selectedRanges: TopLevelBlockRange[]) {
  return selectedRanges.length === 1 && isListNode(selectedRanges[0]!.node);
}

function normalizeLineText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeLooseText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getNodeSize(node: unknown): number {
  if (!isObjectNode(node)) {
    return 0;
  }

  if (isTextNode(node)) {
    return node.text.length;
  }

  return 2 + (node.content ?? []).reduce<number>((size, child) => size + getNodeSize(child), 0);
}

function getNodeText(node: TiptapNode): string {
  if (isTextNode(node)) {
    return node.text;
  }

  const childTexts = (node.content ?? [])
    .map((child) => (isObjectNode(child) ? getNodeText(child) : ""))
    .filter(Boolean);

  return childTexts.join(shouldSeparateChildText(node) ? "\n" : "");
}

function getDirectListItemText(node: TiptapNode): string {
  return (node.content ?? [])
    .map((child) => (isObjectNode(child) && !isListNode(child) ? getNodeText(child) : ""))
    .filter(Boolean)
    .join("\n");
}

function replaceBlockText(blockNode: TiptapNode, text: string): TiptapNode {
  if (blockNode.type === "blockquote" || isListItemNode(blockNode)) {
    return {
      ...blockNode,
      content: text ? [createParagraphNode(text)] : [],
    };
  }

  return {
    ...blockNode,
    content: text ? [{ type: "text", text }] : [],
  };
}

function createSelectionReplacementBlock(blockNode: TiptapNode, text: string): TiptapNode {
  return isListNode(blockNode) ? createParagraphNode(text) : replaceBlockText(blockNode, text);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function replaceOccurrenceInNode(
  node: TiptapNode,
  targetText: string,
  replacementText: string,
  occurrence: { remaining: number },
): { node: TiptapNode; replaced: boolean } {
  const content = node.content ?? [];
  const replacedTextRun = replaceOccurrenceInTextRuns(content, targetText, replacementText, occurrence);
  if (replacedTextRun.replaced) {
    return { node: { ...node, content: replacedTextRun.content }, replaced: true };
  }

  const nextContent: unknown[] = [];
  let replaced = false;

  for (const child of content) {
    if (!replaced && isObjectNode(child) && !isTextNode(child)) {
      const childReplacement = replaceOccurrenceInNode(child, targetText, replacementText, occurrence);
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
        nextContent.push(child, createInsertionBlockAfter(child, insertedText));
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

function insertBelowOccurrenceBlock(
  node: TiptapNode,
  targetText: string,
  insertedText: string,
  occurrence: { remaining: number },
): { node: TiptapNode; inserted: boolean } {
  const content = node.content ?? [];
  const nextContent: unknown[] = [];
  let inserted = false;

  for (const child of content) {
    if (!inserted && isObjectNode(child) && !isTextNode(child)) {
      const childOccurrenceCount = countOccurrencesInNode(child, targetText);

      if (isBlockNode(child) && childOccurrenceCount > 0) {
        if (occurrence.remaining < childOccurrenceCount) {
          nextContent.push(child, createInsertionBlockAfter(child, insertedText));
          inserted = true;
          continue;
        }

        occurrence.remaining -= childOccurrenceCount;
        nextContent.push(child);
        continue;
      }

      const childInsertion = insertBelowOccurrenceBlock(child, targetText, insertedText, occurrence);
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

function replaceOccurrenceInTextRuns(
  content: unknown[],
  targetText: string,
  replacementText: string,
  occurrence: { remaining: number },
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

    const offsets = getOccurrenceOffsets(runText, targetText);
    if (occurrence.remaining < offsets.length) {
      const occurrenceStart = offsets[occurrence.remaining]!;
      return {
        content: replaceTextRun(content, pieces, occurrenceStart, occurrenceStart + targetText.length, replacementText),
        replaced: true,
      };
    }

    occurrence.remaining -= offsets.length;
    index = Math.max(index, runStart + 1);
  }

  return { content, replaced: false };
}

function getOccurrenceOffsets(text: string, targetText: string) {
  const offsets: number[] = [];
  let offset = text.indexOf(targetText);

  while (offset !== -1) {
    offsets.push(offset);
    offset = text.indexOf(targetText, offset + 1);
  }

  return offsets;
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTextNode(value: unknown): value is TiptapNode & { text: string } {
  return isObjectNode(value) && typeof value.text === "string";
}

function isBlockNode(value: TiptapNode) {
  return (
    value.type === "paragraph" ||
    value.type === "heading" ||
    value.type === "blockquote" ||
    value.type === "codeBlock" ||
    isListItemNode(value)
  );
}

function isListNode(value: TiptapNode) {
  return value.type === "bulletList" || value.type === "orderedList" || value.type === "taskList";
}

function isListItemNode(value: TiptapNode) {
  return value.type === "listItem" || value.type === "taskItem";
}

function shouldSeparateChildText(value: TiptapNode) {
  return (
    value.type === "doc" ||
    value.type === "blockquote" ||
    value.type === "bulletList" ||
    value.type === "orderedList" ||
    value.type === "taskList" ||
    isListItemNode(value)
  );
}

function createInsertionBlockAfter(blockNode: TiptapNode, text: string): TiptapNode {
  if (isListItemNode(blockNode)) {
    return createListItemNodes(text, blockNode)[0]!;
  }

  return createParagraphNode(text);
}

function createParagraphNode(text: string): TiptapNode {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
}
