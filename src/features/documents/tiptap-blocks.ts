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
  sourceParentPath?: number[];
  targetListIndex?: number;
  targetParentPath?: number[];
};

export type MoveListItemToTopLevelInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
  sourceParentPath?: number[];
};

export type MoveTopLevelBlockToListItemInput = {
  dropIndex: number;
  listIndex: number;
  sourceIndex: number;
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
  { dropIndex, listIndex, sourceIndex, sourceParentPath = [], targetListIndex = listIndex, targetParentPath = [] }: MoveListItemInput,
): MoveTopLevelBlockResult {
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
      sourceParentPath,
      targetListIndex,
      targetParentPath,
    });
  }

  if (samePath(sourceParentPath, targetParentPath)) {
    return moveListItemInsideSameParent(contentJson, listNode, {
      dropIndex,
      listIndex,
      sourceIndex,
      sourceParentPath,
      targetParentPath,
    });
  }

  const sourceItemPath = [...sourceParentPath, sourceIndex];
  if (startsWithPath(targetParentPath, sourceItemPath)) {
    return { changed: false, contentJson };
  }

  const removal = removeListItemAtParentPath(listNode, sourceParentPath, sourceIndex);
  if (!removal) {
    return { changed: false, contentJson };
  }

  const adjustedTargetParentPath = adjustListParentPathAfterRemoval(targetParentPath, sourceParentPath, sourceIndex);
  const targetListNode = readListNodeAtParentPath(removal.listNode, adjustedTargetParentPath);
  const targetListContent = Array.isArray(targetListNode?.content) ? targetListNode.content : [];
  if (!targetListNode) {
    return { changed: false, contentJson };
  }

  const nextTargetListContent = [...targetListContent];
  nextTargetListContent.splice(clamp(dropIndex, 0, targetListContent.length), 0, removal.item);

  const nextContent = [...content];
  nextContent[listIndex] = updateListNodeAtParentPath(removal.listNode, adjustedTargetParentPath, (targetList) => ({
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
  { dropIndex, listIndex, sourceIndex, sourceParentPath = [], targetListIndex, targetParentPath = [] }: MoveListItemInput & {
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

  const removal = removeListItemAtParentPath(sourceTopListNode, sourceParentPath, sourceIndex);
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

  const targetListNode = readListNodeAtParentPath(adjustedTargetTopListNode, targetParentPath);
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
  nextContent[adjustedTargetListIndex] = updateListNodeAtParentPath(adjustedTargetTopListNode, targetParentPath, (targetList) => ({
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
  { dropIndex, listIndex, sourceIndex, sourceParentPath = [] }: MoveListItemInput,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const sourceListNode = readListNodeAtParentPath(listNode, sourceParentPath);
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
  nextContent[listIndex] = updateListNodeAtParentPath(listNode, sourceParentPath, (targetListNode) => ({
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
  { dropIndex, listIndex, sourceIndex, sourceParentPath = [] }: MoveListItemToTopLevelInput,
): MoveTopLevelBlockResult {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  const listNode = content[listIndex] as TiptapJson | undefined;
  const sourceListNode = listNode ? readListNodeAtParentPath(listNode, sourceParentPath) : null;
  const listContent = Array.isArray(sourceListNode?.content) ? sourceListNode.content : [];
  if (!listNode || !sourceListNode || sourceIndex < 0 || sourceIndex >= listContent.length) {
    return { changed: false, contentJson };
  }

  const clampedDropIndex = clamp(dropIndex, 0, content.length);
  if (
    sourceParentPath.length === 0 &&
    listContent.length === 1 &&
    (clampedDropIndex === listIndex || clampedDropIndex === listIndex + 1)
  ) {
    return { changed: false, contentJson };
  }

  const removal = removeListItemAtParentPath(listNode, sourceParentPath, sourceIndex);
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
  { dropIndex, listIndex, sourceIndex, targetParentPath = [] }: MoveTopLevelBlockToListItemInput,
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

  const adjustedListIndex = sourceIndex < listIndex ? listIndex - 1 : listIndex;
  const nextContent = content.filter((_node, index) => index !== sourceIndex);
  const adjustedListNode = nextContent[adjustedListIndex] as TiptapJson | undefined;
  if (!adjustedListNode || !isListNode(adjustedListNode)) {
    return { changed: false, contentJson };
  }

  const targetListNode = readListNodeAtParentPath(adjustedListNode, targetParentPath);
  const targetListContent = Array.isArray(targetListNode?.content) ? targetListNode.content : [];
  if (!targetListNode) {
    return { changed: false, contentJson };
  }

  const nextTargetListContent = [...targetListContent];
  nextTargetListContent.splice(clamp(dropIndex, 0, targetListContent.length), 0, createListItemFromBlock(sourceNode, targetListNode));
  nextContent[adjustedListIndex] = updateListNodeAtParentPath(adjustedListNode, targetParentPath, (targetList) => ({
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

function readListNodeAtParentPath(listNode: TiptapJson, parentPath: number[]): TiptapJson | null {
  let currentList: TiptapJson | null = listNode;

  for (const itemIndex of parentPath) {
    const listContent = Array.isArray(currentList?.content) ? currentList.content : [];
    const listItem = listContent[itemIndex] as TiptapJson | undefined;
    currentList = readNestedListNode(listItem);
    if (!currentList) {
      return null;
    }
  }

  return currentList;
}

function updateListNodeAtParentPath(
  listNode: TiptapJson,
  parentPath: number[],
  updater: (listNode: TiptapJson) => TiptapJson,
): TiptapJson {
  if (parentPath.length === 0) {
    return updater(listNode);
  }

  const [itemIndex, ...remainingPath] = parentPath;
  const listContent = Array.isArray(listNode.content) ? listNode.content : [];
  const listItem = listContent[itemIndex] as TiptapJson | undefined;
  if (!listItem || !Array.isArray(listItem.content)) {
    return listNode;
  }

  let updatedNestedList = false;
  const nextItemContent = listItem.content.map((child) => {
    if (updatedNestedList || !isListNode(child)) {
      return child;
    }

    updatedNestedList = true;
    return updateListNodeAtParentPath(child, remainingPath, updater);
  });

  if (!updatedNestedList) {
    return listNode;
  }

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

function removeListItemAtParentPath(
  listNode: TiptapJson,
  parentPath: number[],
  sourceIndex: number,
): { item: TiptapJson; listNode: TiptapJson } | null {
  const listContent = Array.isArray(listNode.content) ? listNode.content : [];

  if (parentPath.length === 0) {
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

  const [itemIndex, ...remainingPath] = parentPath;
  const listItem = listContent[itemIndex] as TiptapJson | undefined;
  const itemContent = Array.isArray(listItem?.content) ? listItem.content : [];
  if (!listItem || !Array.isArray(listItem.content)) {
    return null;
  }

  const nestedListIndex = itemContent.findIndex((child) => isListNode(child));
  const nestedList = itemContent[nestedListIndex] as TiptapJson | undefined;
  if (!nestedList) {
    return null;
  }

  const removal = removeListItemAtParentPath(nestedList, remainingPath, sourceIndex);
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

function readNestedListNode(listItem: TiptapJson | undefined) {
  const content = Array.isArray(listItem?.content) ? listItem.content : [];
  return (content.find((child) => isListNode(child)) as TiptapJson | undefined) ?? null;
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

function adjustListParentPathAfterRemoval(targetParentPath: number[], sourceParentPath: number[], sourceIndex: number) {
  if (targetParentPath.length <= sourceParentPath.length || !startsWithPath(targetParentPath, sourceParentPath)) {
    return targetParentPath;
  }

  const affectedIndex = targetParentPath[sourceParentPath.length]!;
  if (affectedIndex <= sourceIndex) {
    return targetParentPath;
  }

  return targetParentPath.map((value, index) => (index === sourceParentPath.length ? value - 1 : value));
}
