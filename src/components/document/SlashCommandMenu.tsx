"use client";

import type { Editor } from "@tiptap/react";
import {
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  Sparkles,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { EditorLanguage } from "@/features/i18n/editor-language";
import { editorMessages } from "@/features/i18n/editor-language";
import { createAiContinueSlashCommand, createDefaultSlashCommands } from "@/plugins/builtin/slash-menu-plugin";
import type {
  EditorSlashCommand,
  EditorSlashCommandGroup,
  EditorSlashCommandIcon,
  EditorSlashCommandRange,
} from "@/plugins/types";

type SlashMenuState = {
  left: number;
  query: string;
  range: EditorSlashCommandRange;
  selectedIndex: number;
  top: number;
};

type SlashCommandMenuProps = {
  editor: Editor | null;
  frameRef: RefObject<HTMLDivElement | null>;
  language: EditorLanguage;
  onAiCommand?: (command: string) => void;
  slashCommands?: EditorSlashCommand[];
};

const SLASH_MENU_MARGIN = 16;
const SLASH_MENU_MAX_HEIGHT = 352;
const SLASH_MENU_WIDTH = 320;

export type SlashCommandItem = EditorSlashCommand;

const slashIconMap: Record<EditorSlashCommandIcon, LucideIcon> = {
  "check-square": CheckSquare,
  code: Code2,
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  list: List,
  "list-ordered": ListOrdered,
  minus: Minus,
  quote: Quote,
  sparkles: Sparkles,
  type: Type,
};

export function SlashCommandMenu({ editor, frameRef, language, onAiCommand, slashCommands }: SlashCommandMenuProps) {
  const messages = editorMessages[language].slashMenu;
  const allItems = useMemo(() => {
    const items = slashCommands ?? createSlashCommandItems(language);

    if (!onAiCommand || items.some((item) => item.id === "ai_continue")) {
      return items;
    }

    return [...items, createAiContinueSlashCommand(editorMessages[language], onAiCommand)];
  }, [language, onAiCommand, slashCommands]);
  const [menuState, setMenuState] = useState<SlashMenuState | null>(null);

  const refreshMenuState = useCallback(() => {
    if (!editor) {
      setMenuState(null);
      return;
    }

    setMenuState((currentState) => {
      const nextState = readSlashMenuState(editor, frameRef.current, currentState?.selectedIndex ?? 0);
      if (!nextState) return null;

      const filteredItems = filterSlashCommandItems(allItems, nextState.query);
      if (filteredItems.length === 0) return null;

      return {
        ...nextState,
        selectedIndex: Math.min(nextState.selectedIndex, filteredItems.length - 1),
      };
    });
  }, [allItems, editor, frameRef]);

  useEffect(() => {
    if (!editor) return;

    editor.on("transaction", refreshMenuState);
    editor.on("selectionUpdate", refreshMenuState);
    editor.on("update", refreshMenuState);

    return () => {
      editor.off("transaction", refreshMenuState);
      editor.off("selectionUpdate", refreshMenuState);
      editor.off("update", refreshMenuState);
    };
  }, [editor, refreshMenuState]);

  const filteredItems = useMemo(
    () => (menuState ? filterSlashCommandItems(allItems, menuState.query) : []),
    [allItems, menuState],
  );

  useEffect(() => {
    if (!editor || !menuState) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        setMenuState(null);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuState((currentState) =>
          currentState
            ? {
                ...currentState,
                selectedIndex: (currentState.selectedIndex + 1) % Math.max(filteredItems.length, 1),
              }
            : currentState,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuState((currentState) =>
          currentState
            ? {
                ...currentState,
                selectedIndex:
                  (currentState.selectedIndex - 1 + Math.max(filteredItems.length, 1)) %
                  Math.max(filteredItems.length, 1),
              }
            : currentState,
        );
        return;
      }

      if (event.key === "Enter") {
        const selectedItem = filteredItems[menuState.selectedIndex];
        if (!selectedItem) return;

        event.preventDefault();
        runSlashCommand(selectedItem, editor, menuState.range);
        setMenuState(null);
      }
    };

    editor.view.dom.addEventListener("keydown", handleKeyDown, true);

    return () => {
      editor.view.dom.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [editor, filteredItems, menuState]);

  if (!editor || !menuState || filteredItems.length === 0) return null;

  return (
    <div
      aria-label={messages.menuLabel}
      className="absolute z-40 w-[min(20rem,calc(100%-2rem))] overflow-y-auto rounded-md border border-zinc-200 bg-white/95 p-1 shadow-xl shadow-zinc-950/15 backdrop-blur"
      onMouseDown={(event) => event.preventDefault()}
      role="listbox"
      style={{ left: menuState.left, maxHeight: SLASH_MENU_MAX_HEIGHT, top: menuState.top }}
    >
      {groupSlashItems(filteredItems).map(([group, items]) => (
        <div key={group}>
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-normal text-zinc-400">
            {messages.groups[group]}
          </div>
          <div className="space-y-0.5">
            {items.map((item) => {
              const absoluteIndex = filteredItems.findIndex((candidate) => candidate.id === item.id);
              const isSelected = absoluteIndex === menuState.selectedIndex;
              const Icon = slashIconMap[item.icon];

              return (
                <button
                  aria-selected={isSelected}
                  className={[
                    "flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm text-zinc-700 outline-none",
                    isSelected ? "bg-zinc-100 text-zinc-950" : "hover:bg-zinc-50 hover:text-zinc-950",
                  ].join(" ")}
                  key={item.id}
                  onClick={() => {
                    runSlashCommand(item, editor, menuState.range);
                    setMenuState(null);
                  }}
                  role="option"
                  type="button"
                >
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-500">
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.label}</span>
                    <span className="block truncate text-xs text-zinc-500">{item.subtext}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function filterSlashCommandItems(items: SlashCommandItem[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items.filter((item) =>
    [item.label, item.subtext, item.searchText, ...item.aliases]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function createSlashCommandItems(
  language: EditorLanguage,
  onAiCommand?: (command: string) => void,
): SlashCommandItem[] {
  const messages = editorMessages[language];
  const items = createDefaultSlashCommands(messages);

  if (onAiCommand) {
    items.push(createAiContinueSlashCommand(messages, onAiCommand));
  }

  return items;
}

function readSlashMenuState(editor: Editor, frame: HTMLDivElement | null, selectedIndex: number): SlashMenuState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;

  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = /(?:^|\s)\/([\p{L}\p{N}_-]*)$/u.exec(textBeforeCursor);
  if (!match) return null;

  const query = match[1] ?? "";
  const range = {
    from: selection.from - query.length - 1,
    to: selection.from,
  };

  return {
    left: readSlashMenuLeft(editor, frame),
    query,
    range,
    selectedIndex,
    top: readSlashMenuTop(editor, frame),
  };
}

function readSlashMenuLeft(editor: Editor, frame: HTMLDivElement | null) {
  if (!frame) return SLASH_MENU_MARGIN;

  try {
    const frameRect = frame.getBoundingClientRect();
    const cursorRect = editor.view.coordsAtPos(editor.state.selection.from);
    return clamp(
      cursorRect.left - frameRect.left,
      SLASH_MENU_MARGIN,
      Math.max(SLASH_MENU_MARGIN, frame.clientWidth - SLASH_MENU_WIDTH - SLASH_MENU_MARGIN),
    );
  } catch {
    return SLASH_MENU_MARGIN;
  }
}

function readSlashMenuTop(editor: Editor, frame: HTMLDivElement | null) {
  if (!frame) return SLASH_MENU_MARGIN;

  try {
    const frameRect = frame.getBoundingClientRect();
    const cursorRect = editor.view.coordsAtPos(editor.state.selection.from);
    const visibleTop = frame.scrollTop + SLASH_MENU_MARGIN;
    const visibleBottom = frame.scrollTop + frame.clientHeight - SLASH_MENU_MARGIN;
    const belowTop = cursorRect.bottom - frameRect.top + frame.scrollTop + 8;
    const aboveTop = cursorRect.top - frameRect.top + frame.scrollTop - SLASH_MENU_MAX_HEIGHT - 8;
    const preferredTop =
      belowTop + SLASH_MENU_MAX_HEIGHT > visibleBottom && aboveTop >= visibleTop ? aboveTop : belowTop;

    return clamp(preferredTop, visibleTop, Math.max(visibleTop, visibleBottom - SLASH_MENU_MAX_HEIGHT));
  } catch {
    return Math.max(SLASH_MENU_MARGIN, frame.scrollTop + 48);
  }
}

function groupSlashItems(items: SlashCommandItem[]) {
  const grouped = new Map<EditorSlashCommandGroup, SlashCommandItem[]>();

  items.forEach((item) => {
    grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
  });

  return Array.from(grouped.entries());
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function runSlashCommand(item: SlashCommandItem, editor: Editor, range: EditorSlashCommandRange) {
  try {
    item.command(editor, range);
  } catch (error) {
    console.error(`Slash command "${item.id}" failed.`, error);
  }
}
