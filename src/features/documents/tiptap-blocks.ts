import type { TiptapJson } from "@/db/schema";

type TiptapNodeJson = {
  attrs?: Record<string, unknown>;
  content?: unknown[];
  type?: string;
};

export type MoveTopLevelBlockResult = {
  changed: boolean;
  contentJson: TiptapJson;
};

export type MoveListItemInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
  // Alternates parent item index and nested-list ordinal from the top-level list.
  sourceListPath?: number[];
  sourceParentPath?: number[];
  targetListIndex?: number;
  targetListPath?: number[];
  targetParentPath?: number[];
};

export type MoveListItemToTopLevelInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
  sourceListPath?: number[];
  sourceParentPath?: number[];
};

export type MoveTopLevelBlockToListItemInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
  targetListPath?: number[];
  targetParentPath?: number[];
};

export type MoveTopLevelBlockBetweenListItemsInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
};

export type ConvertListItemToTopLevelParagraphInput = {
  listIndex: number;
  sourceIndex: number;
};

export type IndentListItemInput = {
  listIndex: number;
  sourceIndex: number;
  sourceListPath?: number[];
  sourceParentPath?: number[];
};

export type IndentListItemResult =
  | { changed: false; contentJson: TiptapJson }
  | {
      changed: true;
      contentJson: TiptapJson;
      destination: { itemIndex: number; nestedListOrdinal: number };
    };

export function indentListItemInTiptapJson(
  contentJson: TiptapJson,
  { listIndex, sourceIndex, sourceListPath, sourceParentPath = [] }: IndentListItemInput,
): IndentListItemResult {
  const resolvedSourceListPath = resolveListPath(sourceListPath, sourceParentPath);
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const topLevelList = content[listIndex] as TiptapJson | undefined;
  const sourceList = topLevelList ? readListNodeAtPath(topLevelList, resolvedSourceListPath) : null;
  const listContent = Array.isArray(sourceList?.content) ? sourceList.content : [];
  if (!topLevelList || !sourceList || sourceIndex <= 0 || sourceIndex >= listContent.length) {
    return { changed: false, contentJson };
  }

  const movedItem = listContent[sourceIndex] as TiptapNodeJson | undefined;
  const previousItem = listContent[sourceIndex - 1] as TiptapNodeJson | undefined;
  if (!movedItem || !previousItem || !Array.isArray(previousItem.content)) {
    return { changed: false, contentJson };
  }

  const previousContent = [...previousItem.content];
  const terminalChildIndex = previousContent.length - 1;
  const terminalChild = previousContent[terminalChildIndex] as TiptapNodeJson | undefined;
  const canReuseTerminalList = isListNode(terminalChild) && terminalChild.type === sourceList.type;
  const nestedListOrdinal = previousContent.filter(isListNode).length - (canReuseTerminalList ? 1 : 0);
  const targetList = canReuseTerminalList
    ? terminalChild
    : { ...sourceList, content: [] };
  const targetContent = Array.isArray(targetList.content) ? targetList.content : [];
  const nextNestedList = {
    ...targetList,
    content: [...targetContent, normalizeListItemForTargetList(movedItem, targetList)],
  };
  if (canReuseTerminalList) previousContent[terminalChildIndex] = nextNestedList;
  else previousContent.push(nextNestedList);

  const nextListContent = listContent
    .filter((_item, index) => index !== sourceIndex)
    .map((item, index) => index === sourceIndex - 1
      ? { ...previousItem, content: previousContent }
      : item);
  const nextContent = [...content];
  nextContent[listIndex] = updateListNodeAtPath(topLevelList, resolvedSourceListPath, (listNode) => ({
    ...listNode,
    content: nextListContent,
  }));

  return {
    changed: true,
    contentJson: { ...contentJson, content: nextContent },
    destination: { itemIndex: targetContent.length, nestedListOrdinal },
  };
}

export function moveTopLevelBlockInTiptapJson(
  contentJson: TiptapJson,
  sourceIndex: number,
  dropIndex: number,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  if (sourceIndex < 0 || sourceIndex >= content.length) {
    return { changed: false, contentJson };
  }

  const clampedDropIndex = clamp(dropIndex, 0, content.length);
  if (clampedDropIndex === sourceIndex || clampedDropIndex === sourceIndex + 1) {
    return { changed: false, contentJson };
  }

  const nextContent = [...content];
  const [movedBlock] = nextContent.splice(sourceIndex, 1);
  const adjustedDropIndex = sourceIndex < clampedDropIndex ? clampedDropIndex - 1 : clampedDropIndex;
  nextContent.splice(adjustedDropIndex, 0, movedBlock);

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

export function moveListItemInTiptapJson(
  contentJson: TiptapJson,
  input: MoveListItemInput,
): MoveTopLevelBlockResult {
  const {
    dropIndex,
    listIndex,
    sourceIndex,
    sourceListPath,
    sourceParentPath = [],
    targetListIndex = listIndex,
    targetListPath,
    targetParentPath = [],
  } = input;
  const resolvedSourceListPath = resolveListPath(sourceListPath, sourceParentPath);
  const resolvedTargetListPath = resolveListPath(targetListPath, targetParentPath);
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const listNode = content[listIndex] as TiptapJson | undefined;
  if (!listNode) {
    return { changed: false, contentJson };
  }
  if (targetListIndex !== listIndex) {
    return moveListItemAcrossTopLevelLists(contentJson, {
      dropIndex,
      listIndex,
      sourceIndex,
      sourceListPath: resolvedSourceListPath,
      targetListIndex,
      targetListPath: resolvedTargetListPath,
    });
  }

  if (samePath(resolvedSourceListPath, resolvedTargetListPath)) {
    return moveListItemInsideSameParent(contentJson, listNode, {
      dropIndex,
      listIndex,
      sourceIndex,
      sourceListPath: resolvedSourceListPath,
      targetListPath: resolvedTargetListPath,
    });
  }

  const sourceItemPath = [...resolvedSourceListPath, sourceIndex];
  if (startsWithPath(resolvedTargetListPath, sourceItemPath)) {
    return { changed: false, contentJson };
  }

  const sourceListNode = readListNodeAtPath(listNode, resolvedSourceListPath);
  const sourceListWillBeRemoved = Array.isArray(sourceListNode?.content) && sourceListNode.content.length === 1;
  const removal = removeListItemAtPath(listNode, resolvedSourceListPath, sourceIndex);
  if (!removal) {
    return { changed: false, contentJson };
  }

  const adjustedTargetListPath = adjustListPathAfterRemoval(
    resolvedTargetListPath,
    resolvedSourceListPath,
    sourceIndex,
    sourceListWillBeRemoved,
  );
  const targetListNode = readListNodeAtPath(removal.listNode, adjustedTargetListPath);
  const targetListContent = Array.isArray(targetListNode?.content) ? targetListNode.content : [];
  if (!targetListNode) {
    return { changed: false, contentJson };
  }

  const nextTargetListContent = [...targetListContent];
  nextTargetListContent.splice(clamp(dropIndex, 0, targetListContent.length), 0, removal.item);

  const nextContent = [...content];
  nextContent[listIndex] = updateListNodeAtPath(removal.listNode, adjustedTargetListPath, (targetList) => ({
    ...targetList,
    content: nextTargetListContent,
  }));

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

function moveListItemAcrossTopLevelLists(
  contentJson: TiptapJson,
  { dropIndex, listIndex, sourceIndex, sourceListPath = [], targetListIndex, targetListPath = [] }: MoveListItemInput & {
    targetListIndex: number;
  },
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const sourceTopListNode = content[listIndex] as TiptapJson | undefined;
  const targetTopListNode = content[targetListIndex] as TiptapJson | undefined;
  if (
    !sourceTopListNode ||
    !targetTopListNode ||
    !isListNode(sourceTopListNode) ||
    !isListNode(targetTopListNode) ||
    listIndex < 0 ||
    listIndex >= content.length ||
    targetListIndex < 0 ||
    targetListIndex >= content.length
  ) {
    return { changed: false, contentJson };
  }

  const removal = removeListItemAtPath(sourceTopListNode, sourceListPath, sourceIndex);
  if (!removal) {
    return { changed: false, contentJson };
  }

  const nextContent = [...content];
  const nextSourceListContent = Array.isArray(removal.listNode.content) ? removal.listNode.content : [];
  let adjustedTargetListIndex = targetListIndex;
  if (nextSourceListContent.length === 0) {
    nextContent.splice(listIndex, 1);
    adjustedTargetListIndex = listIndex < targetListIndex ? targetListIndex - 1 : targetListIndex;
  } else {
    nextContent[listIndex] = removal.listNode;
  }

  const adjustedTargetTopListNode = nextContent[adjustedTargetListIndex] as TiptapJson | undefined;
  if (!adjustedTargetTopListNode || !isListNode(adjustedTargetTopListNode)) {
    return { changed: false, contentJson };
  }

  const targetListNode = readListNodeAtPath(adjustedTargetTopListNode, targetListPath);
  const targetListContent = Array.isArray(targetListNode?.content) ? targetListNode.content : [];
  if (!targetListNode) {
    return { changed: false, contentJson };
  }

  const nextTargetListContent = [...targetListContent];
  nextTargetListContent.splice(
    clamp(dropIndex, 0, targetListContent.length),
    0,
    normalizeListItemForTargetList(removal.item, targetListNode),
  );
  nextContent[adjustedTargetListIndex] = updateListNodeAtPath(adjustedTargetTopListNode, targetListPath, (targetList) => ({
    ...targetList,
    content: nextTargetListContent,
  }));

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

function moveListItemInsideSameParent(
  contentJson: TiptapJson,
  listNode: TiptapJson,
  { dropIndex, listIndex, sourceIndex, sourceListPath = [] }: MoveListItemInput,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const sourceListNode = readListNodeAtPath(listNode, sourceListPath);
  const listContent = Array.isArray(sourceListNode?.content) ? sourceListNode.content : [];
  if (!sourceListNode || sourceIndex < 0 || sourceIndex >= listContent.length) {
    return { changed: false, contentJson };
  }

  const clampedDropIndex = clamp(dropIndex, 0, listContent.length);
  if (clampedDropIndex === sourceIndex || clampedDropIndex === sourceIndex + 1) {
    return { changed: false, contentJson };
  }

  const nextListContent = [...listContent];
  const [movedItem] = nextListContent.splice(sourceIndex, 1);
  const adjustedDropIndex = sourceIndex < clampedDropIndex ? clampedDropIndex - 1 : clampedDropIndex;
  nextListContent.splice(adjustedDropIndex, 0, movedItem);

  const nextContent = [...content];
  nextContent[listIndex] = updateListNodeAtPath(listNode, sourceListPath, (targetListNode) => ({
    ...targetListNode,
    content: nextListContent,
  }));

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

export function moveListItemToTopLevelInTiptapJson(
  contentJson: TiptapJson,
  { dropIndex, listIndex, sourceIndex, sourceListPath, sourceParentPath = [] }: MoveListItemToTopLevelInput,
): MoveTopLevelBlockResult {
  const resolvedSourceListPath = resolveListPath(sourceListPath, sourceParentPath);
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const listNode = content[listIndex] as TiptapJson | undefined;
  const sourceListNode = listNode ? readListNodeAtPath(listNode, resolvedSourceListPath) : null;
  const listContent = Array.isArray(sourceListNode?.content) ? sourceListNode.content : [];
  if (!listNode || !sourceListNode || sourceIndex < 0 || sourceIndex >= listContent.length) {
    return { changed: false, contentJson };
  }

  const clampedDropIndex = clamp(dropIndex, 0, content.length);
  if (
    resolvedSourceListPath.length === 0 &&
    listContent.length === 1 &&
    (clampedDropIndex === listIndex || clampedDropIndex === listIndex + 1)
  ) {
    return { changed: false, contentJson };
  }

  const removal = removeListItemAtPath(listNode, resolvedSourceListPath, sourceIndex);
  if (!removal) {
    return { changed: false, contentJson };
  }

  const nextContent = [...content];
  const movedListNode = {
    ...sourceListNode,
    content: [removal.item],
  };
  const nextSourceListContent = Array.isArray(removal.listNode.content) ? removal.listNode.content : [];
  let adjustedDropIndex = clampedDropIndex;

  if (nextSourceListContent.length === 0) {
    nextContent.splice(listIndex, 1);
    adjustedDropIndex = clampedDropIndex > listIndex ? clampedDropIndex - 1 : clampedDropIndex;
  } else {
    nextContent[listIndex] = removal.listNode;
  }
  nextContent.splice(adjustedDropIndex, 0, movedListNode);

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

export function moveTopLevelBlockToListItemInTiptapJson(
  contentJson: TiptapJson,
  { dropIndex, listIndex, sourceIndex, targetListPath, targetParentPath = [] }: MoveTopLevelBlockToListItemInput,
): MoveTopLevelBlockResult {
  const resolvedTargetListPath = resolveListPath(targetListPath, targetParentPath);
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const sourceNode = content[sourceIndex] as TiptapJson | undefined;
  const listNode = content[listIndex] as TiptapJson | undefined;
  if (
    !sourceNode ||
    !listNode ||
    sourceIndex === listIndex ||
    sourceIndex < 0 ||
    sourceIndex >= content.length ||
    listIndex < 0 ||
    listIndex >= content.length ||
    !isListNode(listNode)
  ) {
    return { changed: false, contentJson };
  }

  const adjustedListIndex = sourceIndex < listIndex ? listIndex - 1 : listIndex;
  const nextContent = content.filter((_node, index) => index !== sourceIndex);
  const adjustedListNode = nextContent[adjustedListIndex] as TiptapJson | undefined;
  if (!adjustedListNode || !isListNode(adjustedListNode)) {
    return { changed: false, contentJson };
  }

  const targetListNode = readListNodeAtPath(adjustedListNode, resolvedTargetListPath);
  const targetListContent = Array.isArray(targetListNode?.content) ? targetListNode.content : [];
  if (!targetListNode) {
    return { changed: false, contentJson };
  }

  const nextTargetListContent = [...targetListContent];
  nextTargetListContent.splice(clamp(dropIndex, 0, targetListContent.length), 0, createListItemFromBlock(sourceNode, targetListNode));
  nextContent[adjustedListIndex] = updateListNodeAtPath(adjustedListNode, resolvedTargetListPath, (targetList) => ({
    ...targetList,
    content: nextTargetListContent,
  }));

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

export function moveTopLevelBlockBetweenListItemsInTiptapJson(
  contentJson: TiptapJson,
  { dropIndex, listIndex, sourceIndex }: MoveTopLevelBlockBetweenListItemsInput,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const sourceNode = content[sourceIndex] as TiptapJson | undefined;
  const listNode = content[listIndex] as TiptapJson | undefined;
  if (
    !sourceNode ||
    !listNode ||
    sourceIndex === listIndex ||
    sourceIndex < 0 ||
    sourceIndex >= content.length ||
    listIndex < 0 ||
    listIndex >= content.length ||
    !isListNode(listNode)
  ) {
    return { changed: false, contentJson };
  }

  const listContent = Array.isArray(listNode.content) ? listNode.content : [];
  const clampedDropIndex = clamp(dropIndex, 0, listContent.length);
  if (listContent.length === 0) {
    return { changed: false, contentJson };
  }

  const adjustedListIndex = sourceIndex < listIndex ? listIndex - 1 : listIndex;
  const nextContent = content.filter((_node, index) => index !== sourceIndex);
  const adjustedListNode = nextContent[adjustedListIndex] as TiptapJson | undefined;
  if (!adjustedListNode || !isListNode(adjustedListNode)) {
    return { changed: false, contentJson };
  }

  const adjustedListContent = Array.isArray(adjustedListNode.content) ? adjustedListNode.content : [];
  const beforeItems = adjustedListContent.slice(0, clampedDropIndex);
  const afterItems = adjustedListContent.slice(clampedDropIndex);
  const replacementNodes: unknown[] = [];

  if (beforeItems.length > 0) {
    replacementNodes.push({
      ...adjustedListNode,
      content: beforeItems,
    });
  }

  replacementNodes.push(sourceNode);

  if (afterItems.length > 0) {
    replacementNodes.push(createContinuationListNode(adjustedListNode, afterItems, beforeItems.length));
  }

  nextContent.splice(adjustedListIndex, 1, ...replacementNodes);

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

export function convertListItemToTopLevelParagraphInTiptapJson(
  contentJson: TiptapJson,
  { listIndex, sourceIndex }: ConvertListItemToTopLevelParagraphInput,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const listNode = content[listIndex] as TiptapJson | undefined;
  const listContent = Array.isArray(listNode?.content) ? listNode.content : [];
  const sourceItem = listContent[sourceIndex] as TiptapNodeJson | undefined;
  if (
    !listNode ||
    !isListNode(listNode) ||
    !sourceItem ||
    sourceIndex < 0 ||
    sourceIndex >= listContent.length ||
    listIndex < 0 ||
    listIndex >= content.length
  ) {
    return { changed: false, contentJson };
  }

  const beforeItems = listContent.slice(0, sourceIndex);
  const afterItems = listContent.slice(sourceIndex + 1);
  const replacementNodes: unknown[] = [];

  if (beforeItems.length > 0) {
    replacementNodes.push({
      ...listNode,
      content: beforeItems,
    });
  }

  replacementNodes.push(...createTopLevelBlocksFromListItem(sourceItem));

  if (afterItems.length > 0) {
    replacementNodes.push(createContinuationListNode(listNode, afterItems, beforeItems.length + 1));
  }

  const nextContent = [...content];
  nextContent.splice(listIndex, 1, ...replacementNodes);

  return {
    changed: true,
    contentJson: {
      ...contentJson,
      content: nextContent,
    },
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readListNodeAtPath(listNode: TiptapJson, listPath: number[]): TiptapJson | null {
  if (!isListPath(listPath)) return null;
  let currentList: TiptapJson | null = listNode;

  for (let pathIndex = 0; pathIndex < listPath.length; pathIndex += 2) {
    const itemIndex = listPath[pathIndex]!;
    const nestedListOrdinal = listPath[pathIndex + 1]!;
    const listContent = Array.isArray(currentList?.content) ? currentList.content : [];
    const listItem = listContent[itemIndex] as TiptapJson | undefined;
    currentList = readNestedListNode(listItem, nestedListOrdinal);
    if (!currentList) {
      return null;
    }
  }

  return currentList;
}

function updateListNodeAtPath(
  listNode: TiptapJson,
  listPath: number[],
  updater: (listNode: TiptapJson) => TiptapJson,
): TiptapJson {
  if (!isListPath(listPath)) return listNode;
  if (listPath.length === 0) {
    return updater(listNode);
  }

  const [itemIndex, nestedListOrdinal, ...remainingPath] = listPath;
  const listContent = Array.isArray(listNode.content) ? listNode.content : [];
  const listItem = listContent[itemIndex] as TiptapJson | undefined;
  if (!listItem || !Array.isArray(listItem.content)) {
    return listNode;
  }

  const nestedListIndex = findNestedListIndex(listItem.content, nestedListOrdinal);
  if (nestedListIndex < 0) return listNode;
  const nestedList = listItem.content[nestedListIndex] as TiptapJson;
  const nextItemContent = listItem.content.map((child, index) =>
    index === nestedListIndex ? updateListNodeAtPath(nestedList, remainingPath, updater) : child,
  );

  return {
    ...listNode,
    content: listContent.map((item, index) =>
      index === itemIndex
        ? {
            ...listItem,
            content: nextItemContent,
          }
        : item,
    ),
  };
}

function removeListItemAtPath(
  listNode: TiptapJson,
  listPath: number[],
  sourceIndex: number,
): { item: TiptapJson; listNode: TiptapJson } | null {
  if (!isListPath(listPath)) return null;
  const listContent = Array.isArray(listNode.content) ? listNode.content : [];

  if (listPath.length === 0) {
    if (sourceIndex < 0 || sourceIndex >= listContent.length) {
      return null;
    }

    const item = listContent[sourceIndex] as TiptapJson | undefined;
    if (!item) {
      return null;
    }

    return {
      item,
      listNode: {
        ...listNode,
        content: listContent.filter((_child, index) => index !== sourceIndex),
      },
    };
  }

  const [itemIndex, nestedListOrdinal, ...remainingPath] = listPath;
  const listItem = listContent[itemIndex] as TiptapJson | undefined;
  const itemContent = Array.isArray(listItem?.content) ? listItem.content : [];
  if (!listItem || !Array.isArray(listItem.content)) {
    return null;
  }

  const nestedListIndex = findNestedListIndex(itemContent, nestedListOrdinal);
  const nestedList = itemContent[nestedListIndex] as TiptapJson | undefined;
  if (!nestedList) {
    return null;
  }

  const removal = removeListItemAtPath(nestedList, remainingPath, sourceIndex);
  if (!removal) {
    return null;
  }

  const remainingNestedContent = Array.isArray(removal.listNode.content) ? removal.listNode.content : [];
  const nextItemContent =
    remainingNestedContent.length === 0
      ? itemContent.filter((_child, index) => index !== nestedListIndex)
      : itemContent.map((child, index) => (index === nestedListIndex ? removal.listNode : child));

  return {
    item: removal.item,
    listNode: {
      ...listNode,
      content: listContent.map((item, index) =>
        index === itemIndex
          ? {
              ...listItem,
              content: nextItemContent,
            }
          : item,
      ),
    },
  };
}

function readNestedListNode(listItem: TiptapJson | undefined, nestedListOrdinal: number) {
  const content = Array.isArray(listItem?.content) ? listItem.content : [];
  const nestedListIndex = findNestedListIndex(content, nestedListOrdinal);
  return nestedListIndex < 0 ? null : content[nestedListIndex] as TiptapJson;
}

function findNestedListIndex(content: unknown[], nestedListOrdinal: number) {
  if (!Number.isSafeInteger(nestedListOrdinal) || nestedListOrdinal < 0) return -1;
  let currentOrdinal = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (!isListNode(content[index])) continue;
    if (currentOrdinal === nestedListOrdinal) return index;
    currentOrdinal += 1;
  }
  return -1;
}

function isListNode(node: unknown): node is TiptapJson {
  return Boolean(
    node &&
      typeof node === "object" &&
      ("type" in node) &&
      (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList"),
  );
}

function createListItemFromBlock(blockNode: TiptapNodeJson, targetListNode: TiptapNodeJson): TiptapNodeJson {
  return {
    attrs: targetListNode.type === "taskList" ? { checked: false } : undefined,
    content: normalizeListItemContent(blockNode),
    type: targetListNode.type === "taskList" ? "taskItem" : "listItem",
  };
}

function normalizeListItemContent(blockNode: TiptapNodeJson): TiptapNodeJson[] {
  if (blockNode.type === "paragraph") {
    return [blockNode];
  }

  if (blockNode.type === "heading") {
    return [
      {
        content: blockNode.content,
        type: "paragraph",
      },
    ];
  }

  return [{ type: "paragraph" }, blockNode];
}

function normalizeListItemForTargetList(listItemNode: TiptapNodeJson, targetListNode: TiptapNodeJson): TiptapNodeJson {
  const content = Array.isArray(listItemNode.content) ? listItemNode.content : [{ type: "paragraph" }];
  if (targetListNode.type === "taskList") {
    return {
      ...listItemNode,
      attrs: { checked: Boolean(listItemNode.attrs?.checked) },
      content,
      type: "taskItem",
    };
  }

  return {
    ...listItemNode,
    attrs: undefined,
    content,
    type: "listItem",
  };
}

function createTopLevelBlocksFromListItem(listItemNode: TiptapNodeJson): TiptapNodeJson[] {
  const itemContent = Array.isArray(listItemNode.content) ? listItemNode.content : [];
  const [firstChild, ...remainingChildren] = itemContent as TiptapNodeJson[];
  const paragraph =
    firstChild?.type === "paragraph"
      ? firstChild
      : {
          type: "paragraph",
        };

  return [paragraph, ...remainingChildren];
}

function createContinuationListNode(listNode: TiptapNodeJson, content: unknown[], skippedItemCount: number): TiptapNodeJson {
  if (listNode.type !== "orderedList") {
    return {
      ...listNode,
      content,
    };
  }

  return {
    ...listNode,
    attrs: {
      ...(typeof listNode.attrs === "object" && listNode.attrs !== null ? listNode.attrs : {}),
      start: readOrderedListStart(listNode) + skippedItemCount,
    },
    content,
  };
}

function readOrderedListStart(listNode: TiptapNodeJson) {
  const start = listNode.attrs?.start;
  return typeof start === "number" && Number.isFinite(start) ? start : 1;
}

function samePath(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function startsWithPath(path: number[], prefix: number[]) {
  return path.length >= prefix.length && prefix.every((value, index) => path[index] === value);
}

function adjustListPathAfterRemoval(
  targetListPath: number[],
  sourceListPath: number[],
  sourceIndex: number,
  sourceListWillBeRemoved: boolean,
) {
  if (sourceListWillBeRemoved && sourceListPath.length >= 2) {
    const sourceParentItemPath = sourceListPath.slice(0, -1);
    const sourceListOrdinal = sourceListPath[sourceListPath.length - 1]!;
    const targetListOrdinalIndex = sourceParentItemPath.length;
    const targetListOrdinal = targetListPath[targetListOrdinalIndex];
    if (
      targetListPath.length > targetListOrdinalIndex &&
      startsWithPath(targetListPath, sourceParentItemPath) &&
      typeof targetListOrdinal === "number" &&
      targetListOrdinal > sourceListOrdinal
    ) {
      return targetListPath.map((value, index) => index === targetListOrdinalIndex ? value - 1 : value);
    }
  }

  if (targetListPath.length <= sourceListPath.length || !startsWithPath(targetListPath, sourceListPath)) {
    return targetListPath;
  }

  const affectedIndex = targetListPath[sourceListPath.length]!;
  if (affectedIndex <= sourceIndex) {
    return targetListPath;
  }

  return targetListPath.map((value, index) => (index === sourceListPath.length ? value - 1 : value));
}

function resolveListPath(listPath: number[] | undefined, legacyParentPath: number[]) {
  return listPath ?? legacyParentPath.flatMap((itemIndex) => [itemIndex, 0]);
}

function isListPath(path: number[]) {
  return path.length % 2 === 0 && path.every((value) => Number.isSafeInteger(value) && value >= 0);
}
