import type { TiptapJson } from "@/db/schema";
import {
  indentListItemInTiptapJson,
  moveListItemInTiptapJson,
  moveListItemToTopLevelInTiptapJson,
  moveTopLevelBlockBetweenListItemsInTiptapJson,
  moveTopLevelBlockInTiptapJson,
  moveTopLevelBlockToListItemInTiptapJson,
} from "./tiptap-blocks";

// List-item paths start with the top-level list index, then alternate item index
// and nested-list ordinal until the final item index.
export type DocumentBlockLocation =
  | { kind: "listItem"; path: number[] }
  | { kind: "topLevel"; path: [number] };

export type DocumentBlockDestination = DocumentBlockLocation;

export type DocumentBlockRelativeTarget =
  | { kind: "betweenListItems"; path: number[]; placement: "after" | "before" }
  | {
      destinationKind?: "listItem" | "topLevel";
      kind: "listItem";
      path: number[];
      placement: "after" | "before";
    }
  | { kind: "relative"; direction: "down" | "indent" | "outdent" | "up" }
  | { kind: "topLevel"; path: [number]; placement: "after" | "before" };

export type DocumentBlockSlotTarget =
  | { index: number; kind: "topLevelSlot" }
  | { index: number; kind: "listItemSlot"; listPath: number[] }
  | { index: number; kind: "betweenListItemsSlot"; listPath: number[] };

export type DocumentBlockMoveIntent = {
  documentSignature?: string;
  source: DocumentBlockLocation;
  target: DocumentBlockRelativeTarget | DocumentBlockSlotTarget;
};

export type DocumentBlockMoveResult =
  | { changed: false; reason: "invalid" | "same_slot" | "stale" }
  | { changed: true; contentJson: TiptapJson; destination: DocumentBlockDestination };

type NormalizedTarget =
  | { dropIndex: number; kind: "betweenListItems"; listIndex: number }
  | { dropIndex: number; indent?: boolean; kind: "listItem"; listIndex: number; parentPath: number[] }
  | { dropIndex: number; kind: "topLevel" };

type ParsedListItemPath = {
  itemIndex: number;
  listIndex: number;
  parentPath: number[];
};

export type DocumentBlockRangeInput = {
  kind: "listItem" | "topLevel";
  listItemPath?: number[];
  topLevelIndex: number;
};

export type DocumentBlockDropInput = {
  action?: "indent" | "outdent";
  dropIndex: number;
  kind: "betweenListItems" | "listItem" | "listLevel" | "topLevel";
  listItemPath?: number[];
  topLevelIndex?: number;
};

type DocumentNodeJson = {
  content?: unknown[];
  type?: string;
};

export function getDocumentBlockSignature(contentJson: TiptapJson) {
  return JSON.stringify(contentJson);
}

export function createDocumentBlockLocation(input: DocumentBlockRangeInput): DocumentBlockLocation | null {
  if (!isInteger(input.topLevelIndex) || input.topLevelIndex < 0) return null;
  if (input.kind === "topLevel") return { kind: "topLevel", path: [input.topLevelIndex] };
  if (!input.listItemPath || input.listItemPath.length === 0) return null;
  return { kind: "listItem", path: [input.topLevelIndex, ...input.listItemPath] };
}

export function createDocumentBlockMoveTarget(input: DocumentBlockDropInput): DocumentBlockMoveIntent["target"] | null {
  if (input.kind === "listLevel") {
    return input.action ? { direction: input.action, kind: "relative" } : null;
  }
  if (input.kind === "topLevel") return { index: input.dropIndex, kind: "topLevelSlot" };
  if (typeof input.topLevelIndex !== "number") return null;
  if (input.kind === "betweenListItems") {
    return { index: input.dropIndex, kind: "betweenListItemsSlot", listPath: [input.topLevelIndex] };
  }
  return {
    index: input.dropIndex,
    kind: "listItemSlot",
    listPath: [input.topLevelIndex, ...(input.listItemPath ?? [])],
  };
}

export function moveDocumentBlock(
  contentJson: TiptapJson,
  intent: DocumentBlockMoveIntent,
): DocumentBlockMoveResult {
  if (
    intent.documentSignature !== undefined &&
    intent.documentSignature !== getDocumentBlockSignature(contentJson)
  ) {
    return { changed: false, reason: "stale" };
  }

  if (!isValidLocation(contentJson, intent.source)) {
    return { changed: false, reason: "invalid" };
  }

  const target = normalizeTarget(contentJson, intent.source, intent.target);
  if (!target) {
    return { changed: false, reason: "invalid" };
  }

  if (isSameSlot(contentJson, intent.source, target)) {
    return { changed: false, reason: "same_slot" };
  }

  if (intent.source.kind === "topLevel") {
    return moveTopLevelSource(contentJson, intent.source.path[0], target);
  }

  const source = parseListItemPath(intent.source.path);
  if (!source || target.kind === "betweenListItems") {
    return { changed: false, reason: "invalid" };
  }

  return moveListItemSource(contentJson, source, target);
}

function moveTopLevelSource(
  contentJson: TiptapJson,
  sourceIndex: number,
  target: NormalizedTarget,
): DocumentBlockMoveResult {
  if (target.kind === "topLevel") {
    const result = moveTopLevelBlockInTiptapJson(contentJson, sourceIndex, target.dropIndex);
    if (!result.changed) return { changed: false, reason: "invalid" };
    return {
      changed: true,
      contentJson: result.contentJson,
      destination: {
        kind: "topLevel",
        path: [movedTopLevelIndex(sourceIndex, target.dropIndex, topLevelLength(contentJson))],
      },
    };
  }

  if (target.kind === "betweenListItems") {
    const result = moveTopLevelBlockBetweenListItemsInTiptapJson(contentJson, {
      dropIndex: target.dropIndex,
      listIndex: target.listIndex,
      sourceIndex,
    });
    if (!result.changed) return { changed: false, reason: "invalid" };
    return {
      changed: true,
      contentJson: result.contentJson,
      destination: {
        kind: "topLevel",
        path: [movedTopLevelIndexInsideSplitList(contentJson, sourceIndex, target)],
      },
    };
  }

  const result = moveTopLevelBlockToListItemInTiptapJson(contentJson, {
    dropIndex: target.dropIndex,
    listIndex: target.listIndex,
    sourceIndex,
    targetListPath: target.parentPath,
  });
  if (!result.changed) return { changed: false, reason: "invalid" };
  return {
    changed: true,
    contentJson: result.contentJson,
    destination: {
      kind: "listItem",
      path: [
        sourceIndex < target.listIndex ? target.listIndex - 1 : target.listIndex,
        ...target.parentPath,
        target.dropIndex,
      ],
    },
  };
}

function moveListItemSource(
  contentJson: TiptapJson,
  source: ParsedListItemPath,
  target: Exclude<NormalizedTarget, { kind: "betweenListItems" }>,
): DocumentBlockMoveResult {
  if (target.kind === "listItem" && target.indent) {
    const result = indentListItemInTiptapJson(contentJson, {
      listIndex: source.listIndex,
      sourceIndex: source.itemIndex,
      sourceListPath: source.parentPath,
    });
    if (!result.changed) return { changed: false, reason: "same_slot" };
    return {
      changed: true,
      contentJson: result.contentJson,
      destination: {
        kind: "listItem",
        path: [
          source.listIndex,
          ...source.parentPath,
          source.itemIndex - 1,
          result.destination.nestedListOrdinal,
          result.destination.itemIndex,
        ],
      },
    };
  }

  if (target.kind === "topLevel") {
    const sourceListRemoved = willRemoveSourceTopLevelList(contentJson, source);
    const result = moveListItemToTopLevelInTiptapJson(contentJson, {
      dropIndex: target.dropIndex,
      listIndex: source.listIndex,
      sourceIndex: source.itemIndex,
      sourceListPath: source.parentPath,
    });
    if (!result.changed) return { changed: false, reason: "invalid" };
    return {
      changed: true,
      contentJson: result.contentJson,
      destination: {
        kind: "listItem",
        path: [
          sourceListRemoved
            ? movedTopLevelIndex(source.listIndex, target.dropIndex, topLevelLength(contentJson))
            : clamp(target.dropIndex, 0, topLevelLength(contentJson)),
          0,
        ],
      },
    };
  }

  const sourceItemPath = [...source.parentPath, source.itemIndex];
  if (
    source.listIndex === target.listIndex &&
    startsWithPath(target.parentPath, sourceItemPath)
  ) {
    return { changed: false, reason: "invalid" };
  }

  const result = moveListItemInTiptapJson(contentJson, {
    dropIndex: target.dropIndex,
    listIndex: source.listIndex,
    sourceIndex: source.itemIndex,
    sourceListPath: source.parentPath,
    targetListIndex: target.listIndex,
    targetListPath: target.parentPath,
  });
  if (!result.changed) return { changed: false, reason: "invalid" };

  const sourceListRemoved = willRemoveSourceTopLevelList(contentJson, source);
  const sourceNestedListRemoved = willRemoveSourceNestedList(contentJson, source);
  const destinationListIndex =
    source.listIndex !== target.listIndex && sourceListRemoved && source.listIndex < target.listIndex
      ? target.listIndex - 1
      : target.listIndex;
  const adjustedParentPath = source.listIndex === target.listIndex
    ? adjustListParentPathAfterRemoval(
        target.parentPath,
        source.parentPath,
        source.itemIndex,
        sourceNestedListRemoved,
      )
    : target.parentPath;
  const destinationIndex =
    source.listIndex === target.listIndex &&
    samePath(source.parentPath, target.parentPath) &&
    source.itemIndex < target.dropIndex
      ? target.dropIndex - 1
      : target.dropIndex;

  return {
    changed: true,
    contentJson: result.contentJson,
    destination: {
      kind: "listItem",
      path: [destinationListIndex, ...adjustedParentPath, Math.max(0, destinationIndex)],
    },
  };
}

function normalizeTarget(
  contentJson: TiptapJson,
  source: DocumentBlockLocation,
  target: DocumentBlockRelativeTarget | DocumentBlockSlotTarget,
): NormalizedTarget | null {
  if (target.kind === "relative") {
    return normalizeRelativeTarget(contentJson, source, target.direction);
  }

  if (target.kind === "topLevelSlot") {
    return isInteger(target.index) && target.index >= 0 && target.index <= topLevelLength(contentJson)
      ? { dropIndex: target.index, kind: "topLevel" }
      : null;
  }

  if (target.kind === "listItemSlot" || target.kind === "betweenListItemsSlot") {
    const listPath = parseListPath(target.listPath);
    if (!listPath || !isValidListPath(contentJson, listPath.listIndex, listPath.parentPath)) return null;
    if (target.kind === "betweenListItemsSlot" && listPath.parentPath.length > 0) return null;
    const length = listLengthAtPath(contentJson, listPath.listIndex, listPath.parentPath);
    if (!isInteger(target.index) || target.index < 0 || target.index > length) return null;
    return target.kind === "listItemSlot"
      ? {
          dropIndex: target.index,
          kind: "listItem",
          listIndex: listPath.listIndex,
          parentPath: listPath.parentPath,
        }
      : { dropIndex: target.index, kind: "betweenListItems", listIndex: listPath.listIndex };
  }

  if (target.kind === "topLevel") {
    if (!isValidLocation(contentJson, target)) return null;
  } else if (!readListItemAtPath(contentJson, target.path)) {
    return null;
  }
  const placementOffset = target.placement === "after" ? 1 : 0;
  if (target.kind === "topLevel") {
    return { dropIndex: target.path[0] + placementOffset, kind: "topLevel" };
  }

  const parsed = parseListItemPath(target.path);
  if (!parsed) return null;
  if (
    (target.kind === "betweenListItems" || target.destinationKind === "topLevel") &&
    parsed.parentPath.length > 0
  ) {
    return null;
  }
  return target.kind === "listItem" && target.destinationKind !== "topLevel"
    ? {
        dropIndex: parsed.itemIndex + placementOffset,
        kind: "listItem",
        listIndex: parsed.listIndex,
        parentPath: parsed.parentPath,
      }
    : {
        dropIndex: parsed.itemIndex + placementOffset,
        kind: "betweenListItems",
        listIndex: parsed.listIndex,
      };
}

function normalizeRelativeTarget(
  contentJson: TiptapJson,
  source: DocumentBlockLocation,
  direction: Extract<DocumentBlockRelativeTarget, { kind: "relative" }>["direction"],
): NormalizedTarget | null {
  if (source.kind === "topLevel") {
    if (direction === "outdent" || direction === "indent") return null;
    const sourceIndex = source.path[0];
    return {
      dropIndex: clamp(
        direction === "up" ? sourceIndex - 1 : sourceIndex + 2,
        0,
        topLevelLength(contentJson),
      ),
      kind: "topLevel",
    };
  }

  const parsed = parseListItemPath(source.path);
  if (!parsed) return null;
  if (direction === "indent") {
    return {
      dropIndex: parsed.itemIndex,
      indent: true,
      kind: "listItem",
      listIndex: parsed.listIndex,
      parentPath: parsed.parentPath,
    };
  }
  if (direction === "outdent") {
    if (parsed.parentPath.length === 0) return null;
    const parentIndex = parsed.parentPath[parsed.parentPath.length - 2]!;
    return {
      dropIndex: parentIndex + 1,
      kind: "listItem",
      listIndex: parsed.listIndex,
      parentPath: parsed.parentPath.slice(0, -2),
    };
  }
  return {
    dropIndex: clamp(
      direction === "up" ? parsed.itemIndex - 1 : parsed.itemIndex + 2,
      0,
      listLengthAtPath(contentJson, parsed.listIndex, parsed.parentPath),
    ),
    kind: "listItem",
    listIndex: parsed.listIndex,
    parentPath: parsed.parentPath,
  };
}

function isSameSlot(contentJson: TiptapJson, source: DocumentBlockLocation, target: NormalizedTarget) {
  if (source.kind === "topLevel" && target.kind === "topLevel") {
    const sourceIndex = source.path[0];
    return target.dropIndex === sourceIndex || target.dropIndex === sourceIndex + 1;
  }
  if (source.kind !== "listItem") return false;
  const parsed = parseListItemPath(source.path);
  if (
    parsed &&
    target.kind === "topLevel" &&
    parsed.parentPath.length === 0 &&
    willRemoveSourceTopLevelList(contentJson, parsed)
  ) {
    return target.dropIndex === parsed.listIndex || target.dropIndex === parsed.listIndex + 1;
  }
  if (target.kind !== "listItem" || target.indent) return false;
  return Boolean(
    parsed &&
      parsed.listIndex === target.listIndex &&
      samePath(parsed.parentPath, target.parentPath) &&
      (target.dropIndex === parsed.itemIndex || target.dropIndex === parsed.itemIndex + 1),
  );
}

function isValidLocation(contentJson: TiptapJson, location: DocumentBlockLocation) {
  if (location.kind === "topLevel") {
    return location.path.length === 1 && isValidTopLevelIndex(contentJson, location.path[0]);
  }
  return Boolean(readListItemAtPath(contentJson, location.path));
}

function readListItemAtPath(contentJson: TiptapJson, path: number[]) {
  const parsed = parseListItemPath(path);
  if (!parsed) return null;
  const list = readListAtPath(contentJson, parsed.listIndex, parsed.parentPath);
  const content = Array.isArray(list?.content) ? list.content : [];
  const item = content[parsed.itemIndex] as DocumentNodeJson | undefined;
  return item?.type === "listItem" || item?.type === "taskItem" ? item : null;
}

function isValidListPath(contentJson: TiptapJson, listIndex: number, parentPath: number[]) {
  return readListAtPath(contentJson, listIndex, parentPath) !== null;
}

function listLengthAtPath(contentJson: TiptapJson, listIndex: number, parentPath: number[]) {
  const list = readListAtPath(contentJson, listIndex, parentPath);
  return Array.isArray(list?.content) ? list.content.length : 0;
}

function readListAtPath(contentJson: TiptapJson, listIndex: number, parentPath: number[]) {
  if (!isListPath(parentPath)) return null;
  const topLevel = topLevelContent(contentJson)[listIndex] as DocumentNodeJson | undefined;
  if (!isListNode(topLevel)) return null;
  let list: DocumentNodeJson = topLevel;
  for (let pathIndex = 0; pathIndex < parentPath.length; pathIndex += 2) {
    const itemIndex = parentPath[pathIndex]!;
    const nestedListOrdinal = parentPath[pathIndex + 1]!;
    const item = (Array.isArray(list.content) ? list.content[itemIndex] : undefined) as DocumentNodeJson | undefined;
    if (!item || (item.type !== "listItem" && item.type !== "taskItem")) return null;
    const nested = (Array.isArray(item.content) ? item.content : []).filter(isListNode)[nestedListOrdinal];
    if (!nested) return null;
    list = nested;
  }
  return list;
}

function parseListItemPath(path: number[]): ParsedListItemPath | null {
  if (path.length < 2 || path.length % 2 !== 0 || path.some((value) => !isInteger(value) || value < 0)) return null;
  return {
    itemIndex: path[path.length - 1]!,
    listIndex: path[0]!,
    parentPath: path.slice(1, -1),
  };
}

function parseListPath(path: number[]) {
  if (path.length < 1 || path.length % 2 !== 1 || path.some((value) => !isInteger(value) || value < 0)) return null;
  return { listIndex: path[0]!, parentPath: path.slice(1) };
}

function willRemoveSourceTopLevelList(contentJson: TiptapJson, source: ParsedListItemPath) {
  if (source.parentPath.length > 0) return false;
  const list = topLevelContent(contentJson)[source.listIndex] as DocumentNodeJson | undefined;
  return Array.isArray(list?.content) && list.content.length === 1;
}

function willRemoveSourceNestedList(contentJson: TiptapJson, source: ParsedListItemPath) {
  if (source.parentPath.length === 0) return false;
  const list = readListAtPath(contentJson, source.listIndex, source.parentPath);
  return Array.isArray(list?.content) && list.content.length === 1;
}

function movedTopLevelIndex(sourceIndex: number, dropIndex: number, contentLength: number) {
  const clamped = clamp(dropIndex, 0, contentLength);
  return sourceIndex < clamped ? clamped - 1 : clamped;
}

function movedTopLevelIndexInsideSplitList(
  contentJson: TiptapJson,
  sourceIndex: number,
  target: Extract<NormalizedTarget, { kind: "betweenListItems" }>,
) {
  const list = topLevelContent(contentJson)[target.listIndex] as TiptapJson | undefined;
  const listLength = Array.isArray(list?.content) ? list.content.length : 0;
  const dropIndex = clamp(target.dropIndex, 0, listLength);
  const adjustedListIndex = sourceIndex < target.listIndex ? target.listIndex - 1 : target.listIndex;
  return adjustedListIndex + (dropIndex > 0 ? 1 : 0);
}

function adjustListParentPathAfterRemoval(
  targetParentPath: number[],
  sourceParentPath: number[],
  sourceIndex: number,
  sourceListWillBeRemoved: boolean,
) {
  if (sourceListWillBeRemoved && sourceParentPath.length >= 2) {
    const sourceParentItemPath = sourceParentPath.slice(0, -1);
    const sourceListOrdinal = sourceParentPath[sourceParentPath.length - 1]!;
    const targetListOrdinalIndex = sourceParentItemPath.length;
    const targetListOrdinal = targetParentPath[targetListOrdinalIndex];
    if (
      targetParentPath.length > targetListOrdinalIndex &&
      startsWithPath(targetParentPath, sourceParentItemPath) &&
      typeof targetListOrdinal === "number" &&
      targetListOrdinal > sourceListOrdinal
    ) {
      return targetParentPath.map((value, index) => index === targetListOrdinalIndex ? value - 1 : value);
    }
  }

  if (targetParentPath.length <= sourceParentPath.length || !startsWithPath(targetParentPath, sourceParentPath)) {
    return targetParentPath;
  }
  const affectedIndex = targetParentPath[sourceParentPath.length]!;
  if (affectedIndex <= sourceIndex) return targetParentPath;
  return targetParentPath.map((value, index) => index === sourceParentPath.length ? value - 1 : value);
}

function topLevelContent(contentJson: TiptapJson) {
  return Array.isArray(contentJson.content) ? contentJson.content : [];
}

function topLevelLength(contentJson: TiptapJson) {
  return topLevelContent(contentJson).length;
}

function isValidTopLevelIndex(contentJson: TiptapJson, index: number) {
  return isInteger(index) && index >= 0 && index < topLevelLength(contentJson);
}

function isListNode(node: unknown): node is DocumentNodeJson {
  if (!node || typeof node !== "object" || !("type" in node)) return false;
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

function samePath(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function startsWithPath(path: number[], prefix: number[]) {
  return path.length >= prefix.length && prefix.every((value, index) => path[index] === value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isInteger(value: number) {
  return Number.isSafeInteger(value);
}

function isListPath(path: number[]) {
  return path.length % 2 === 0 && path.every((value) => isInteger(value) && value >= 0);
}
