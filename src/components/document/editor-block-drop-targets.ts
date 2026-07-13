import type { SelectionBlockDragPoint } from "./BlockGutterControls";
import {
  clamp,
  getDirectListItemElementAtViewportY,
  getDropSlotByY,
  getListDomElementByPath,
  getListItemDomPath,
  getListItemElementAtViewportY,
  getListItemOwnIndex,
  getListItemParentPath,
  isListDomElement,
  readBlockDropRect,
  readBlockGutterAnchorRect,
  readListItemContentElement,
  samePath,
  startsWithPath,
  type BlockActionRange,
  type RuntimeEditor,
} from "./editor-block-ranges";

export type BlockDropTarget = {
  action?: "indent" | "outdent";
  dropIndex: number;
  indicator: BlockDropIndicator;
  kind: "betweenListItems" | "listItem" | "listLevel" | "topLevel";
  listItemPath?: number[];
  topLevelIndex?: number;
};

export type BlockDropIndicator = {
  left: number;
  top: number;
  width: number;
};

const LIST_CONTENT_DROP_X_TOLERANCE = 8;
const LIST_LEVEL_DRAG_THRESHOLD = 48;
const LIST_LEVEL_VERTICAL_TOLERANCE = 28;
const LIST_SOURCE_PARENT_DROP_MARGIN = 16;

export function getBlockDropTarget(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const filterTarget = (target: BlockDropTarget | null) => (target && !isNoopBlockDropTarget(source, target) ? target : null);

  if (source.kind === "listItem") {
    const levelDropTarget = getListItemLevelDropTarget(editor, frame, source, point);
    if (levelDropTarget) return filterTarget(levelDropTarget);

    const sourceParentDropTarget = getSourceParentListItemDropTarget(editor, frame, source, point);
    if (sourceParentDropTarget) return filterTarget(sourceParentDropTarget);

    if (isPointInsideSourceList(editor, source, point.clientY)) {
      return filterTarget(getListItemDropTarget(editor, frame, source, point));
    }

    const externalListItemDropTarget = getListItemDropTargetAtPoint(editor, frame, source, point);
    if (externalListItemDropTarget) return filterTarget(externalListItemDropTarget);

    return filterTarget(getTopLevelBlockDropTarget(editor, frame, point));
  }

  const splitListDropTarget = getTopLevelBlockBetweenListItemsDropTargetAtPoint(editor, frame, source, point);
  if (splitListDropTarget) return filterTarget(splitListDropTarget);

  const listItemDropTarget = getListItemDropTargetAtPoint(editor, frame, source, point);
  if (listItemDropTarget) return filterTarget(listItemDropTarget);

  return filterTarget(getTopLevelBlockDropTarget(editor, frame, point));
}

export function isNoopBlockDropTarget(source: BlockActionRange, target: BlockDropTarget) {
  if (target.kind === "listLevel") return false;

  if (source.kind === "topLevel" && target.kind === "topLevel") {
    return target.dropIndex === source.topLevelIndex || target.dropIndex === source.topLevelIndex + 1;
  }

  if (source.kind !== "listItem" || target.kind !== "listItem") {
    return false;
  }

  const sourceIndex = getListItemOwnIndex(source);
  if (typeof sourceIndex !== "number" || target.topLevelIndex !== source.topLevelIndex) {
    return false;
  }

  const sourceParentPath = getListItemParentPath(source);
  const targetParentPath = target.listItemPath ?? [];
  return samePath(sourceParentPath, targetParentPath) && (target.dropIndex === sourceIndex || target.dropIndex === sourceIndex + 1);
}

function isPointInsideSourceList(editor: RuntimeEditor, source: BlockActionRange, clientY: number) {
  const listElement = editor.view.dom.children.item(source.topLevelIndex);
  if (!(listElement instanceof HTMLElement)) return false;

  const rect = listElement.getBoundingClientRect();
  return clientY >= rect.top - 8 && clientY <= rect.bottom + 8;
}

function getListItemLevelDropTarget(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const deltaX = point.deltaX ?? 0;
  const deltaY = point.deltaY ?? 0;
  if (Math.abs(deltaY) > LIST_LEVEL_VERTICAL_TOLERANCE) {
    return null;
  }

  const sourceIndex = getListItemOwnIndex(source);
  const sourceParentPath = getListItemParentPath(source);
  const action =
    deltaX <= -LIST_LEVEL_DRAG_THRESHOLD && sourceParentPath.length > 0
      ? "outdent"
      : deltaX >= LIST_LEVEL_DRAG_THRESHOLD && typeof sourceIndex === "number" && sourceIndex > 0
        ? "indent"
        : null;

  if (!action) {
    return null;
  }

  const indicator = createListLevelDropIndicator(editor, frame, source, action);
  return {
    action,
    dropIndex: sourceIndex ?? 0,
    indicator,
    kind: "listLevel",
    listItemPath: sourceParentPath,
    topLevelIndex: source.topLevelIndex,
  };
}

function getListItemDropTarget(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const listElement = editor.view.dom.children.item(source.topLevelIndex);
  if (!(listElement instanceof HTMLElement)) {
    return null;
  }

  return getListItemDropTargetForList(editor, frame, source.topLevelIndex, listElement, source, point);
}

function getSourceParentListItemDropTarget(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  if (source.kind !== "listItem") return null;

  const listElement = editor.view.dom.children.item(source.topLevelIndex);
  if (!(listElement instanceof HTMLElement) || !isListDomElement(listElement)) {
    return null;
  }

  const sourceParentPath = getListItemParentPath(source);
  const sourceParentList = getListDomElementByPath(listElement, sourceParentPath);
  if (!sourceParentList) return null;

  const listItems = getDirectListItemElements(sourceParentList);
  if (!isPointInsideListDropBand(listItems, point.clientY)) {
    return null;
  }

  return createListItemDropTargetForParentList(editor, frame, source.topLevelIndex, sourceParentList, sourceParentPath, source, point);
}

function getListItemDropTargetAtPoint(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const topLevelElements = Array.from(editor.view.dom.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );

  for (let topLevelIndex = 0; topLevelIndex < topLevelElements.length; topLevelIndex += 1) {
    if (topLevelIndex === source.topLevelIndex) continue;

    const listElement = topLevelElements[topLevelIndex];
    if (!isListDomElement(listElement)) continue;

    const listRect = listElement.getBoundingClientRect();
    if (point.clientY < listRect.top - 8 || point.clientY > listRect.bottom + 8) continue;

    const target = getListItemDropTargetForList(editor, frame, topLevelIndex, listElement, source, point);
    if (target) return target;
  }

  return null;
}

function getTopLevelBlockBetweenListItemsDropTargetAtPoint(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  if (source.kind === "listItem") return null;

  const topLevelElements = Array.from(editor.view.dom.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );

  for (let topLevelIndex = 0; topLevelIndex < topLevelElements.length; topLevelIndex += 1) {
    if (topLevelIndex === source.topLevelIndex) continue;

    const listElement = topLevelElements[topLevelIndex];
    if (!isListDomElement(listElement)) continue;

    const listRect = listElement.getBoundingClientRect();
    if (point.clientY < listRect.top - 8 || point.clientY > listRect.bottom + 8) continue;

    const targetListItem = getDirectListItemElementAtViewportY(listElement, point.clientY);
    if (!targetListItem) continue;

    const contentElement = readListItemContentElement(targetListItem);
    const contentRect = contentElement?.getBoundingClientRect();
    if (contentRect && point.clientX >= contentRect.left - LIST_CONTENT_DROP_X_TOLERANCE) {
      continue;
    }

    const listItems = Array.from(listElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const dropSlot = getDropSlotByY(listItems, point.clientY);
    if (!dropSlot) continue;

    const editorRect = editor.view.dom.getBoundingClientRect();
    return {
      dropIndex: dropSlot.index + (dropSlot.side === "after" ? 1 : 0),
      indicator: createDropIndicator(
        frame,
        dropSlot.side === "after" ? dropSlot.rect.bottom : dropSlot.rect.top,
        editorRect.left,
        editorRect.right,
      ),
      kind: "betweenListItems",
      topLevelIndex,
    };
  }

  return null;
}

function getListItemDropTargetForList(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  topLevelIndex: number,
  listElement: HTMLElement,
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const targetListItem = getListItemElementAtViewportY(listElement, point.clientY);
  if (!targetListItem) return null;

  const targetPath = getListItemDomPath(listElement, targetListItem);
  if (!targetPath) return null;

  const parentList = targetListItem.parentElement;
  if (!(parentList instanceof HTMLElement) || !isListDomElement(parentList)) {
    return null;
  }

  const targetParentPath = targetPath.slice(0, -1);
  return createListItemDropTargetForParentList(editor, frame, topLevelIndex, parentList, targetParentPath, source, point);
}

function createListItemDropTargetForParentList(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  topLevelIndex: number,
  parentList: HTMLElement,
  targetParentPath: number[],
  source: BlockActionRange,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const listItems = getDirectListItemElements(parentList);
  const dropSlot = getDropSlotByY(listItems, point.clientY);
  if (!dropSlot) return null;

  if (isListItemDropInsideSourceDescendant(source, topLevelIndex, targetParentPath)) {
    return null;
  }

  const editorRect = editor.view.dom.getBoundingClientRect();
  return {
    dropIndex: dropSlot.index + (dropSlot.side === "after" ? 1 : 0),
    indicator: createDropIndicator(
      frame,
      dropSlot.side === "after" ? dropSlot.rect.bottom : dropSlot.rect.top,
      dropSlot.rect.left,
      editorRect.right,
    ),
    kind: "listItem",
    listItemPath: targetParentPath,
    topLevelIndex,
  };
}

function getDirectListItemElements(listElement: HTMLElement) {
  return Array.from(listElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
}

function isPointInsideListDropBand(listItems: HTMLElement[], clientY: number) {
  if (listItems.length === 0) return false;

  const firstRect = readBlockDropRect(listItems[0]);
  const lastRect = readBlockDropRect(listItems[listItems.length - 1]);
  return clientY >= firstRect.top - LIST_SOURCE_PARENT_DROP_MARGIN && clientY <= lastRect.bottom + LIST_SOURCE_PARENT_DROP_MARGIN;
}

function isListItemDropInsideSourceDescendant(
  source: BlockActionRange,
  targetTopLevelIndex: number,
  targetParentPath: number[],
) {
  if (source.kind !== "listItem" || source.topLevelIndex !== targetTopLevelIndex) {
    return false;
  }

  const sourceItemPath = source.listItemPath;
  return Boolean(sourceItemPath && startsWithPath(targetParentPath, sourceItemPath));
}

function getTopLevelBlockDropTarget(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  point: SelectionBlockDragPoint,
): BlockDropTarget | null {
  const topLevelBlocks = Array.from(editor.view.dom.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  const dropSlot = getDropSlotByY(topLevelBlocks, point.clientY);
  if (!dropSlot) return null;

  const editorRect = editor.view.dom.getBoundingClientRect();
  return {
    dropIndex: dropSlot.index + (dropSlot.side === "after" ? 1 : 0),
    indicator: createDropIndicator(
      frame,
      dropSlot.side === "after" ? dropSlot.rect.bottom : dropSlot.rect.top,
      editorRect.left,
      editorRect.right,
    ),
    kind: "topLevel",
  };
}

function createDropIndicator(frame: HTMLDivElement, viewportTop: number, viewportLeft: number, viewportRight: number) {
  const frameRect = frame.getBoundingClientRect();
  return {
    left: Math.max(8, viewportLeft - frameRect.left),
    top: Math.max(0, viewportTop - frameRect.top + frame.scrollTop - 1),
    width: Math.max(24, viewportRight - viewportLeft),
  };
}

function createListLevelDropIndicator(
  editor: RuntimeEditor,
  frame: HTMLDivElement,
  source: BlockActionRange,
  action: "indent" | "outdent",
) {
  const editorRect = editor.view.dom.getBoundingClientRect();
  const sourceRect = readBlockGutterAnchorRect(editor, source);
  const levelOffset = action === "indent" ? 28 : -28;
  const indicatorLeft = clamp(sourceRect.left + levelOffset, editorRect.left, editorRect.right - 32);

  return createDropIndicator(frame, sourceRect.top, indicatorLeft, editorRect.right);
}
