"use client";

import { ArrowDown, ArrowUp, Copy, FilePlus2, GripVertical, IndentDecrease, IndentIncrease, Plus, Trash2, Type } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  type EditorLanguage,
} from "@/features/i18n/editor-language";

export type SelectionBlockAction =
  | "addBelow"
  | "convertListItemToText"
  | "delete"
  | "duplicate"
  | "indentListItem"
  | "moveDown"
  | "moveUp"
  | "outdentListItem";
export type SelectionBlockDragPoint = {
  clientX: number;
  clientY: number;
  deltaX?: number;
  deltaY?: number;
};

type BlockGutterControlsProps = {
  isListItem?: boolean;
  isRunning?: boolean;
  isVisible: boolean;
  language?: EditorLanguage;
  left: number;
  onAddBlock?: () => void;
  onBlockAction?: (action: SelectionBlockAction) => void;
  onBlockDragEnd?: () => void;
  onBlockDragStart?: () => void;
  onBlockPointerDragEnd?: (point: SelectionBlockDragPoint) => void;
  onBlockPointerDragMove?: (point: SelectionBlockDragPoint) => void;
  top: number;
};

const BLOCK_DRAG_THRESHOLD = 8;

export function BlockGutterControls({
  isListItem = false,
  isRunning = false,
  isVisible,
  language = DEFAULT_EDITOR_LANGUAGE,
  left,
  onAddBlock,
  onBlockAction,
  onBlockDragEnd,
  onBlockDragStart,
  onBlockPointerDragEnd,
  onBlockPointerDragMove,
  top,
}: BlockGutterControlsProps) {
  const [isBlockMenuOpen, setIsBlockMenuOpen] = useState(false);
  const [isBlockDragging, setIsBlockDragging] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const blockPointerDragRef = useRef<{
    isDragging: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressNextClickRef = useRef(false);

  useEffect(() => {
    if (!isBlockMenuOpen) return;

    menuItemRefs.current[0]?.focus();
  }, [isBlockMenuOpen]);

  if (!isVisible) return null;

  const messages = editorMessages[language].selectionMenu.blockControls;
  const style: CSSProperties = { left, top };
  const blockActions = [
    { action: "moveUp", icon: ArrowUp, label: messages.moveUp },
    { action: "moveDown", icon: ArrowDown, label: messages.moveDown },
    ...(isListItem
      ? [
          { action: "outdentListItem", icon: IndentDecrease, label: messages.outdentListItem },
          { action: "indentListItem", icon: IndentIncrease, label: messages.indentListItem },
          { action: "convertListItemToText", icon: Type, label: messages.convertListItemToText },
        ] as const
      : []),
    { action: "addBelow", icon: FilePlus2, label: messages.addBelow },
    { action: "duplicate", icon: Copy, label: messages.duplicateBlock },
    { action: "delete", icon: Trash2, label: messages.deleteBlock },
  ] as const;

  const closeBlockMenu = () => {
    setIsBlockMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = menuItemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "Escape") {
      event.preventDefault();
      closeBlockMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      menuItems[(activeIndex + 1 + menuItems.length) % menuItems.length]?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(activeIndex - 1 + menuItems.length) % menuItems.length]?.focus();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      menuItems[0]?.focus();
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      menuItems[menuItems.length - 1]?.focus();
    }
  };

  return (
    <div
      aria-label={messages.toolbarLabel}
      className="absolute z-30 flex items-start gap-1.5"
      data-block-gutter="true"
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      style={style}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-white/95 px-1.5 text-zinc-500 shadow-lg shadow-zinc-950/10 backdrop-blur">
        <button
          aria-label={messages.addBelow}
          className="inline-flex size-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950"
          onClick={() => onAddBlock?.()}
          title={messages.addBelow}
          type="button"
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-expanded={isBlockMenuOpen}
          aria-haspopup="menu"
          aria-label={messages.openMenu}
          className={[
            "inline-flex size-5 touch-none items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950",
            isBlockDragging ? "cursor-grabbing bg-zinc-100 text-zinc-950" : "cursor-grab",
          ].join(" ")}
          data-block-drag-handle="true"
          draggable={false}
          onClick={(event) => {
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              event.preventDefault();
              onBlockDragEnd?.();
              return;
            }

            onBlockDragEnd?.();
            setIsBlockMenuOpen((currentValue) => !currentValue);
          }}
          onPointerCancel={() => {
            blockPointerDragRef.current = null;
            setIsBlockDragging(false);
            onBlockDragEnd?.();
          }}
          onPointerDown={(event) => {
            if (isRunning || event.button !== 0) return;

            blockPointerDragRef.current = {
              isDragging: false,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onBlockDragStart?.();
          }}
          onPointerMove={(event) => {
            const dragState = blockPointerDragRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId || event.buttons === 0) return;

            const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
            if (!dragState.isDragging && distance < BLOCK_DRAG_THRESHOLD) return;

            dragState.isDragging = true;
            suppressNextClickRef.current = true;
            setIsBlockDragging(true);
            setIsBlockMenuOpen(false);
            event.preventDefault();
            onBlockPointerDragMove?.(readBlockDragPoint(event, dragState));
          }}
          onPointerUp={(event) => {
            const dragState = blockPointerDragRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) return;

            blockPointerDragRef.current = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            setIsBlockDragging(false);
            if (!dragState.isDragging) return;

            suppressNextClickRef.current = true;
            event.preventDefault();
            onBlockPointerDragEnd?.(readBlockDragPoint(event, dragState));
          }}
          title={messages.openMenu}
          type="button"
          ref={menuButtonRef}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {isBlockMenuOpen && !isRunning ? (
        <div
          aria-label={messages.menuLabel}
          className="w-44 rounded-md border border-zinc-200 bg-white/95 p-1 shadow-xl shadow-zinc-950/15 backdrop-blur"
          onKeyDown={handleMenuKeyDown}
          role="menu"
        >
          {blockActions.map(({ action, icon: Icon, label }) => (
            <button
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950"
              key={action}
              onClick={() => {
                closeBlockMenu();
                onBlockAction?.(action);
              }}
              ref={(element) => {
                menuItemRefs.current[blockActions.findIndex((item) => item.action === action)] = element;
              }}
              role="menuitem"
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5 text-zinc-500" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function readBlockDragPoint(
  event: PointerEvent<HTMLButtonElement>,
  dragState: { startX: number; startY: number },
): SelectionBlockDragPoint {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: event.clientX - dragState.startX,
    deltaY: event.clientY - dragState.startY,
  };
}
