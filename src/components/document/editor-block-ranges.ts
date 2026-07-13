import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

export type RuntimeEditor = Editor;

export type TopLevelBlockRange = {
  from: number;
  index: number;
  node: ProseMirrorNode;
  to: number;
};

export type BlockActionRange = {
  from: number;
  kind: "listItem" | "topLevel";
  listItemIndex?: number;
  // Alternates item index and nested-list ordinal, ending with the selected item index.
  listItemPath?: number[];
  node: ProseMirrorNode;
  to: number;
  topLevelIndex: number;
};

export type BlockGutterState = {
  blockIndex: number;
  left: number;
  target: BlockActionRange;
  top: number;
};

export const BLOCK_GUTTER_WIDTH = 58;
export const BLOCK_GUTTER_EDGE_GAP = 8;
export const BLOCK_GUTTER_HORIZONTAL_OFFSET = 68;
export const BLOCK_GUTTER_MIN_TEXT_GAP = 4;
export const LIST_BLOCK_GUTTER_TEXT_GAP = 16;

export function getBlockActionRangeAtPosition(editor: RuntimeEditor, position: number): BlockActionRange | null {
  const resolvedPosition = editor.state.doc.resolve(clamp(position, 0, editor.state.doc.content.size));
  const listItemRange = getListItemBlockActionRange(editor, resolvedPosition);
  if (listItemRange) return listItemRange;

  const topLevelRange = getTopLevelBlockRangeAtPosition(editor, position);
  return topLevelRange ? toTopLevelBlockActionRange(topLevelRange) : null;
}

export function getBlockActionRangeFromDomTarget(
  editor: RuntimeEditor,
  target: EventTarget | null,
  clientY?: number,
): BlockActionRange | null {
  if (!(target instanceof HTMLElement) || !editor.view.dom.contains(target)) return null;

  const topLevelElements = Array.from(editor.view.dom.children);
  const topLevelElement = topLevelElements.find((child) => child === target || child.contains(target));
  if (!(topLevelElement instanceof HTMLElement)) return null;

  const topLevelIndex = topLevelElements.indexOf(topLevelElement);
  if (isListDomElement(topLevelElement) && typeof clientY === "number") {
    const listItemElementAtY = getListItemElementAtViewportY(topLevelElement, clientY);
    if (listItemElementAtY) {
      const nestedRange = getListItemBlockActionRangeFromElement(editor, topLevelIndex, topLevelElement, listItemElementAtY);
      if (nestedRange) return nestedRange;
    }
  }

  const listItemElement = target.closest("li");
  if (listItemElement instanceof HTMLElement && topLevelElement.contains(listItemElement)) {
    const nestedRange = getListItemBlockActionRangeFromElement(editor, topLevelIndex, topLevelElement, listItemElement);
    if (nestedRange) return nestedRange;

    const directListItemElement = Array.from(topLevelElement.children).find(
      (child) => child === listItemElement || child.contains(listItemElement),
    );
    const listItemIndex = Array.from(topLevelElement.children).indexOf(directListItemElement ?? listItemElement);
    return getListItemBlockActionRangeByIndex(editor, topLevelIndex, listItemIndex);
  }
  return getTopLevelBlockActionRangeByIndex(editor, topLevelIndex);
}

export function getBlockActionRangeAtViewportY(editor: RuntimeEditor, clientY: number): BlockActionRange | null {
  const topLevelElements = Array.from(editor.view.dom.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );

  for (let topLevelIndex = 0; topLevelIndex < topLevelElements.length; topLevelIndex += 1) {
    const topLevelElement = topLevelElements[topLevelIndex];
    const rect = topLevelElement.getBoundingClientRect();
    if (clientY < rect.top - 4 || clientY > rect.bottom + 4) {
      continue;
    }

    if (isListDomElement(topLevelElement)) {
      const listItemElementAtY = getListItemElementAtViewportY(topLevelElement, clientY);
      if (listItemElementAtY) {
        const nestedRange = getListItemBlockActionRangeFromElement(editor, topLevelIndex, topLevelElement, listItemElementAtY);
        if (nestedRange) return nestedRange;
      }
    }

    return getTopLevelBlockActionRangeByIndex(editor, topLevelIndex);
  }

  return null;
}

export function getListItemBlockActionRangeByPath(
  editor: RuntimeEditor,
  topLevelIndex: number,
  listItemPath: number[],
): BlockActionRange | null {
  const topLevelRange = getTopLevelBlockRangeByIndex(editor, topLevelIndex);
  if (!topLevelRange || !isListItemPath(listItemPath)) return null;

  let listNode = topLevelRange.node;
  let itemOffset = topLevelRange.from + 1;
  for (let pathIndex = 0; pathIndex < listItemPath.length; pathIndex += 2) {
    const listItemIndex = listItemPath[pathIndex]!;
    if (!isListNodeName(listNode.type.name) || listItemIndex < 0 || listItemIndex >= listNode.childCount) {
      return null;
    }

    for (let index = 0; index < listItemIndex; index += 1) {
      itemOffset += listNode.child(index).nodeSize;
    }

    const node = listNode.child(listItemIndex);
    if (!node || (node.type.name !== "listItem" && node.type.name !== "taskItem")) return null;

    const itemFrom = itemOffset;
    const itemTo = itemFrom + node.nodeSize;
    if (pathIndex === listItemPath.length - 1) {
      return {
        from: itemFrom,
        kind: "listItem",
        listItemIndex,
        listItemPath,
        node,
        to: itemTo,
        topLevelIndex,
      };
    }

    const nestedListOrdinal = listItemPath[pathIndex + 1]!;
    const nestedList = getNestedListChild(node, itemFrom, nestedListOrdinal);
    if (!nestedList) return null;
    listNode = nestedList.node;
    itemOffset = nestedList.from + 1;
  }

  return null;
}

export function getTopLevelBlockActionRangeByIndex(
  editor: RuntimeEditor,
  targetIndex: number | null | undefined,
): BlockActionRange | null {
  if (typeof targetIndex !== "number") return null;

  const range = getTopLevelBlockRangeByIndex(editor, targetIndex);
  return range ? toTopLevelBlockActionRange(range) : null;
}

export function readBlockGutterPosition(
  editor: RuntimeEditor,
  frame: HTMLDivElement | null,
  range: BlockActionRange | null,
): BlockGutterState | null {
  if (!frame || !range) return null;

  try {
    const frameRect = frame.getBoundingClientRect();
    const blockRect = readBlockGutterAnchorRect(editor, range);
    const blockLeft = blockRect.left - frameRect.left;
    const horizontalOffset =
      range.kind === "listItem"
        ? BLOCK_GUTTER_WIDTH + LIST_BLOCK_GUTTER_TEXT_GAP
        : BLOCK_GUTTER_HORIZONTAL_OFFSET;
    const maxLeft = Math.max(0, frame.clientWidth - BLOCK_GUTTER_WIDTH);
    const left =
      blockLeft < BLOCK_GUTTER_WIDTH + BLOCK_GUTTER_MIN_TEXT_GAP
        ? Math.max(0, frame.clientWidth - BLOCK_GUTTER_WIDTH - BLOCK_GUTTER_EDGE_GAP)
        : clamp(blockLeft - horizontalOffset, 0, maxLeft);
    const top = Math.max(0, blockRect.top - frameRect.top + frame.scrollTop - 2);

    return {
      blockIndex: range.topLevelIndex,
      left,
      target: range,
      top,
    };
  } catch {
    return {
      blockIndex: range.topLevelIndex,
      left: 8,
      target: range,
      top: Math.max(0, frame.scrollTop),
    };
  }
}

export function readBlockGutterAnchorRect(
  editor: RuntimeEditor,
  range: BlockActionRange,
): Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top"> {
  if (range.kind === "listItem") {
    const rangeElement = readListItemDomElement(editor, range) ?? editor.view.nodeDOM(range.from);
    if (rangeElement instanceof HTMLElement) {
      const contentElement = readListItemContentElement(rangeElement);
      return (contentElement ?? rangeElement).getBoundingClientRect();
    }
  }

  return readTopLevelBlockDomRect(editor, range);
}

export function isListDomElement(element: HTMLElement) {
  return element.matches("ul, ol");
}

export function getListItemElementAtViewportY(listElement: HTMLElement, clientY: number) {
  const listItems = Array.from(listElement.querySelectorAll<HTMLElement>("li"));
  const directListItem = getDirectListItemElementAtViewportY(listElement, clientY);
  const matchingItems = listItems.filter((listItem) => {
    const rect = (readListItemContentElement(listItem) ?? listItem).getBoundingClientRect();
    return clientY >= rect.top - 4 && clientY <= rect.bottom + 4;
  });

  return matchingItems.sort((left, right) => getElementDepth(right) - getElementDepth(left))[0] ?? directListItem;
}

export function getDirectListItemElementAtViewportY(listElement: HTMLElement, clientY: number) {
  const listItemIndex = getListItemIndexAtViewportY(listElement, clientY);
  return listItemIndex === null
    ? null
    : Array.from(listElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement)[listItemIndex] ?? null;
}

export function readListItemContentElement(listItem: HTMLElement) {
  const directContentElement = Array.from(listItem.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches("p, h1, h2, h3, pre, blockquote"),
  );
  if (directContentElement) return directContentElement;

  for (const child of Array.from(listItem.children)) {
    if (!(child instanceof HTMLElement) || isListDomElement(child)) {
      continue;
    }

    const nestedContentElement = child.querySelector<HTMLElement>("p, h1, h2, h3, pre, blockquote");
    if (nestedContentElement) {
      return nestedContentElement;
    }
  }

  return null;
}

export function getDropSlotByY(elements: HTMLElement[], clientY: number) {
  if (elements.length === 0) return null;

  for (let index = 0; index < elements.length; index += 1) {
    const rect = readBlockDropRect(elements[index]);
    const midpoint = rect.top + rect.height / 2;
    if (clientY <= midpoint) {
      return { index, rect, side: "before" as const };
    }

    if (clientY <= rect.bottom) {
      return { index, rect, side: "after" as const };
    }
  }

  const lastIndex = elements.length - 1;
  return {
    index: lastIndex,
    rect: readBlockDropRect(elements[lastIndex]),
    side: "after" as const,
  };
}

export function readBlockDropRect(element: HTMLElement): Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top"> {
  const contentElement = element.matches("li") ? readListItemContentElement(element) : null;
  const rect = (contentElement ?? element).getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  return {
    bottom: rect.bottom,
    height: rect.bottom - rect.top,
    left: elementRect.left,
    right: elementRect.right,
    top: rect.top,
  };
}

export function getListItemOwnIndex(range: BlockActionRange) {
  if (range.kind !== "listItem") return null;
  if (range.listItemPath && range.listItemPath.length > 0) {
    return range.listItemPath[range.listItemPath.length - 1]!;
  }

  return typeof range.listItemIndex === "number" ? range.listItemIndex : null;
}

export function getListItemParentPath(range: BlockActionRange) {
  if (range.kind !== "listItem" || !range.listItemPath) {
    return [];
  }

  return range.listItemPath.slice(0, -1);
}

export function samePath(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function startsWithPath(path: number[], prefix: number[]) {
  return path.length >= prefix.length && prefix.every((value, index) => path[index] === value);
}

export function getTopLevelBlockRangeByIndex(editor: RuntimeEditor, targetIndex: number): TopLevelBlockRange | null {
  let result: TopLevelBlockRange | null = null;

  editor.state.doc.forEach((node, offset, index) => {
    if (index === targetIndex) {
      result = { from: offset, index, node, to: offset + node.nodeSize };
    }
  });

  return result;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getTopLevelBlockRangeAtPosition(editor: RuntimeEditor, position: number) {
  const targetIndex = getTopLevelBlockIndexAtPosition(editor, position);
  return targetIndex === null ? null : getTopLevelBlockRangeByIndex(editor, targetIndex);
}

function getListItemBlockActionRangeFromElement(
  editor: RuntimeEditor,
  topLevelIndex: number,
  topLevelElement: HTMLElement,
  listItemElement: HTMLElement,
) {
  const listItemPath = getListItemDomPath(topLevelElement, listItemElement);
  return listItemPath ? getListItemBlockActionRangeByPath(editor, topLevelIndex, listItemPath) : null;
}

function getListItemBlockActionRange(
  editor: RuntimeEditor,
  resolvedPosition: ReturnType<RuntimeEditor["state"]["doc"]["resolve"]>,
): BlockActionRange | null {
  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;

    const topLevelIndex = getTopLevelBlockIndexByStart(editor, resolvedPosition.before(1));
    if (topLevelIndex === null) return null;

    return {
      from: resolvedPosition.before(depth),
      kind: "listItem",
      listItemIndex: resolvedPosition.index(depth - 1),
      listItemPath: getListItemPathAtResolvedPosition(resolvedPosition, depth),
      node,
      to: resolvedPosition.after(depth),
      topLevelIndex,
    };
  }

  return null;
}

function getListItemPathAtResolvedPosition(
  resolvedPosition: ReturnType<RuntimeEditor["state"]["doc"]["resolve"]>,
  targetDepth: number,
) {
  const path: number[] = [];

  for (let depth = 1; depth <= targetDepth; depth += 1) {
    const node = resolvedPosition.node(depth);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      path.push(resolvedPosition.index(depth - 1));
      continue;
    }
    if (depth <= 1 || !isListNodeName(node.type.name)) continue;

    const parentItem = resolvedPosition.node(depth - 1);
    const nestedListChildIndex = resolvedPosition.index(depth - 1);
    let nestedListOrdinal = 0;
    for (let childIndex = 0; childIndex < nestedListChildIndex; childIndex += 1) {
      if (isListNodeName(parentItem.child(childIndex).type.name)) nestedListOrdinal += 1;
    }
    path.push(nestedListOrdinal);
  }

  return path;
}

function getListItemBlockActionRangeByIndex(
  editor: RuntimeEditor,
  topLevelIndex: number,
  listItemIndex: number,
): BlockActionRange | null {
  return getListItemBlockActionRangeByPath(editor, topLevelIndex, [listItemIndex]);
}

function getNestedListChild(node: ProseMirrorNode, nodeFrom: number, nestedListOrdinal: number) {
  let childOffset = nodeFrom + 1;
  let currentListOrdinal = 0;
  for (let childIndex = 0; childIndex < node.childCount; childIndex += 1) {
    const child = node.child(childIndex);
    if (isListNodeName(child.type.name)) {
      if (currentListOrdinal === nestedListOrdinal) return { from: childOffset, node: child };
      currentListOrdinal += 1;
    }

    childOffset += child.nodeSize;
  }

  return null;
}

function toTopLevelBlockActionRange(range: TopLevelBlockRange): BlockActionRange {
  return {
    from: range.from,
    kind: "topLevel",
    node: range.node,
    to: range.to,
    topLevelIndex: range.index,
  };
}

function readTopLevelBlockDomRect(
  editor: RuntimeEditor,
  range: BlockActionRange,
): Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top"> {
  if (range.kind === "listItem") {
    const rangeElement = readListItemDomElement(editor, range) ?? editor.view.nodeDOM(range.from);
    if (rangeElement instanceof HTMLElement) {
      return rangeElement.getBoundingClientRect();
    }
  }

  const blockElement = editor.view.dom.children.item(range.topLevelIndex);
  if (blockElement instanceof HTMLElement) {
    return blockElement.getBoundingClientRect();
  }

  const fallbackRect = editor.view.coordsAtPos(Math.min(range.from + 1, editor.state.doc.content.size));
  return {
    ...fallbackRect,
    height: fallbackRect.bottom - fallbackRect.top,
  };
}

function readListItemDomElement(editor: RuntimeEditor, range: BlockActionRange) {
  if (range.kind !== "listItem" || typeof range.listItemIndex !== "number") {
    return null;
  }

  const listElement = editor.view.dom.children.item(range.topLevelIndex);
  if (listElement instanceof HTMLElement && isListDomElement(listElement)) {
    if (range.listItemPath) {
      const pathElement = getListItemDomElementByPath(listElement, range.listItemPath);
      if (pathElement) {
        return pathElement;
      }
    }

    const indexedElement =
      Array.from(listElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement)[
        range.listItemIndex
      ] ?? null;
    if (indexedElement) {
      return indexedElement;
    }
  }

  const rangeElement = editor.view.nodeDOM(range.from);
  if (rangeElement instanceof HTMLElement && rangeElement.matches("li")) {
    return rangeElement;
  }

  return null;
}

export function getListItemDomPath(topLevelElement: HTMLElement, listItemElement: HTMLElement) {
  const path: number[] = [];
  let currentListItem: HTMLElement | null = listItemElement;

  while (currentListItem && currentListItem !== topLevelElement) {
    const parentList: HTMLElement | null = currentListItem.parentElement;
    if (!(parentList instanceof HTMLElement) || !isListDomElement(parentList)) {
      return null;
    }

    const siblings = Array.from(parentList.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const itemIndex = siblings.indexOf(currentListItem);
    if (itemIndex < 0) return null;
    path.unshift(itemIndex);

    if (parentList === topLevelElement) {
      return path;
    }

    const parentListItem: HTMLElement | null = parentList.closest<HTMLElement>("li");
    if (!(parentListItem instanceof HTMLElement)) return null;
    const nestedListOrdinal = getNestedListElements(parentListItem).indexOf(parentList);
    if (nestedListOrdinal < 0) return null;
    path.unshift(nestedListOrdinal);
    currentListItem = parentListItem;
  }

  return null;
}

function getListItemDomElementByPath(topLevelElement: HTMLElement, listItemPath: number[]) {
  if (!isListItemPath(listItemPath)) return null;
  const currentList = getListDomElementByPath(topLevelElement, listItemPath.slice(0, -1));
  return currentList
    ? getDirectListItemElements(currentList)[listItemPath[listItemPath.length - 1]!] ?? null
    : null;
}

export function getListDomElementByPath(topLevelElement: HTMLElement, listPath: number[]) {
  if (!isListPath(listPath)) return null;
  let currentList: HTMLElement | null = topLevelElement;
  for (let pathIndex = 0; pathIndex < listPath.length; pathIndex += 2) {
    const itemIndex = listPath[pathIndex]!;
    const nestedListOrdinal = listPath[pathIndex + 1]!;
    const currentItem: HTMLElement | null = getDirectListItemElements(currentList)[itemIndex] ?? null;
    if (!currentItem) return null;
    currentList = getNestedListElements(currentItem)[nestedListOrdinal] ?? null;
    if (!currentList) return null;
  }
  return currentList;
}

function isListNodeName(nodeName: string) {
  return nodeName === "bulletList" || nodeName === "orderedList" || nodeName === "taskList";
}

function getDirectListItemElements(listElement: HTMLElement) {
  return Array.from(listElement.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches("li"),
  );
}

function getNestedListElements(listItem: HTMLElement) {
  return Array.from(listItem.querySelectorAll<HTMLElement>("ul, ol")).filter(
    (listElement) => listElement.closest("li") === listItem,
  );
}

function isListItemPath(path: number[]) {
  return path.length % 2 === 1 && path.every(isPathIndex);
}

function isListPath(path: number[]) {
  return path.length % 2 === 0 && path.every(isPathIndex);
}

function isPathIndex(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function getListItemIndexAtViewportY(listElement: HTMLElement, clientY: number) {
  const listItems = Array.from(listElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  if (listItems.length === 0) return null;

  for (let index = 0; index < listItems.length; index += 1) {
    const rect = readBlockDropRect(listItems[index]);
    if (clientY >= rect.top - 4 && clientY <= rect.bottom + 4) {
      return index;
    }
  }

  return getDropSlotByY(listItems, clientY)?.index ?? null;
}

function getElementDepth(element: HTMLElement) {
  let depth = 0;
  let currentElement: HTMLElement | null = element;
  while (currentElement?.parentElement) {
    depth += 1;
    currentElement = currentElement.parentElement;
  }

  return depth;
}

function getTopLevelBlockIndexAtPosition(editor: RuntimeEditor, position: number) {
  if (editor.state.doc.childCount === 0) return null;

  const resolvedPosition = editor.state.doc.resolve(clamp(position, 0, editor.state.doc.content.size));
  if (resolvedPosition.depth < 1) return 0;

  return getTopLevelBlockIndexByStart(editor, resolvedPosition.before(1));
}

function getTopLevelBlockIndexByStart(editor: RuntimeEditor, start: number) {
  let foundIndex: number | null = null;

  editor.state.doc.forEach((_node, offset, index) => {
    if (offset === start) {
      foundIndex = index;
    }
  });

  return foundIndex;
}
