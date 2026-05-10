"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CharacterCount from "@tiptap/extension-character-count";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/core";
import type { TiptapJson } from "@/db/schema";
import { SelectionAiMenu } from "./SelectionAiMenu";

type DocumentEditorProps = {
  title: string;
  contentJson: TiptapJson;
  onChange: (draft: { title: string; contentJson: TiptapJson }) => void;
  onSelectionCommand?: (command: string, selectedText: string) => void;
};

type SelectionMenuState = {
  left: number;
  selectedText: string;
  side: SelectionMenuSide;
  top: number;
};

type SelectionMenuSide = "top" | "bottom";

type SelectionRect = Pick<DOMRect, "left" | "right" | "top">;

type SelectionMenuPositionInput = {
  frameRect: Pick<DOMRect, "left" | "top" | "width">;
  scrollTop: number;
  selectedText: string;
  selectionEnd: SelectionRect;
  selectionStart: SelectionRect;
};

const SELECTION_MENU_GAP = 8;
const SELECTION_MENU_HEIGHT = 44;
const SELECTION_LINE_HEIGHT = 32;

export function DocumentEditor({ contentJson, onChange, onSelectionCommand, title }: DocumentEditorProps) {
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const editorFrameRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef(title);
  const onChangeRef = useRef(onChange);
  const onSelectionCommandRef = useRef(onSelectionCommand);
  const contentJsonSignature = useMemo(() => JSON.stringify(contentJson), [contentJson]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSelectionCommandRef.current = onSelectionCommand;
  }, [onSelectionCommand]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        link: false,
      }),
      Placeholder.configure({
        placeholder: "Write the memo...",
      }),
      Link.configure({
        autolink: true,
        openOnClick: false,
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Typography,
      CharacterCount,
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: contentJson as JSONContent,
    editorProps: {
      attributes: {
        "aria-label": "Document body",
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    immediatelyRender: false,
    onSelectionUpdate: ({ editor: currentEditor }) => {
      const { empty, from, to } = currentEditor.state.selection;
      if (empty) {
        setSelectionMenu(null);
        return;
      }

      const selectedText = currentEditor.state.doc.textBetween(from, to, "\n").trim();
      if (!selectedText) {
        setSelectionMenu(null);
        return;
      }

      setSelectionMenu(readSelectionMenuPosition(currentEditor, editorFrameRef.current, selectedText));
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChangeRef.current({
        title: titleRef.current,
        contentJson: currentEditor.getJSON() as TiptapJson,
      });
    },
  });

  useEffect(() => {
    if (!editor) return;

    const editorContentSignature = JSON.stringify(editor.getJSON());
    if (editorContentSignature !== contentJsonSignature) {
      editor.commands.setContent(contentJson as JSONContent, { emitUpdate: false });
    }
  }, [contentJson, contentJsonSignature, editor]);

  const handleTitleChange = useCallback(
    (value: string) => {
      titleRef.current = value;
      onChangeRef.current({
        title: value,
        contentJson: (editor?.getJSON() as TiptapJson | undefined) ?? contentJson,
      });
    },
    [contentJson, editor],
  );

  const handleCommand = useCallback(
    (command: string) => {
      if (!editor) return;

      const { from, to } = editor.state.selection;
      const selectedText = selectionMenu?.selectedText ?? editor.state.doc.textBetween(from, to, "\n").trim();
      onSelectionCommandRef.current?.(command, selectedText);
    },
    [editor, selectionMenu?.selectedText],
  );

  const characterCount = editor?.storage.characterCount.characters() ?? 0;
  const wordCount = editor?.storage.characterCount.words() ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="border-b border-zinc-200 px-6 py-5">
        <input
          aria-label="Document title"
          className="w-full bg-transparent text-2xl font-semibold tracking-normal text-zinc-950 outline-none placeholder:text-zinc-400"
          onChange={(event) => handleTitleChange(event.target.value)}
          value={title}
        />
      </div>
      <SelectionAiMenu hasSelection={selectionMenu !== null} onCommand={handleCommand} side={selectionMenu?.side} />
      <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-6" ref={editorFrameRef}>
        <EditorContent
          className="min-h-full [&_.tiptap]:min-h-[52rem] [&_.tiptap]:max-w-3xl [&_.tiptap]:outline-none [&_.tiptap]:text-base [&_.tiptap]:leading-7 [&_.tiptap]:text-zinc-900 [&_.tiptap_a]:text-zinc-950 [&_.tiptap_a]:underline [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-zinc-300 [&_.tiptap_blockquote]:pl-4 [&_.tiptap_h1]:text-3xl [&_.tiptap_h1]:font-semibold [&_.tiptap_h2]:text-2xl [&_.tiptap_h2]:font-semibold [&_.tiptap_h3]:text-xl [&_.tiptap_h3]:font-semibold [&_.tiptap_li]:my-1 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:text-zinc-400 [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p]:my-3 [&_.tiptap_ul]:my-3 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-6"
          editor={editor}
        />
      </div>
      <footer className="flex items-center justify-end gap-4 border-t border-zinc-200 px-6 py-2 text-xs text-zinc-500">
        <span>{wordCount} words</span>
        <span>{characterCount} characters</span>
      </footer>
    </div>
  );
}

function readSelectionMenuPosition(
  currentEditor: NonNullable<ReturnType<typeof useEditor>>,
  frame: HTMLDivElement | null,
  selectedText: string,
): SelectionMenuState {
  if (!frame) {
    return getFallbackSelectionMenuPosition(selectedText);
  }

  try {
    const { from, to } = currentEditor.state.selection;
    return getSelectionMenuPosition({
      frameRect: frame.getBoundingClientRect(),
      scrollTop: frame.scrollTop,
      selectedText,
      selectionEnd: currentEditor.view.coordsAtPos(to),
      selectionStart: currentEditor.view.coordsAtPos(from),
    });
  } catch {
    return getFallbackSelectionMenuPosition(selectedText);
  }
}

export function getSelectionMenuPosition({
  frameRect,
  scrollTop,
  selectedText,
  selectionEnd,
  selectionStart,
}: SelectionMenuPositionInput): SelectionMenuState {
  const menuWidth = Math.min(360, Math.max(240, frameRect.width - 32));
  const selectionLeft = Math.min(selectionStart.left, selectionEnd.left);
  const selectionRight = Math.max(selectionStart.right, selectionEnd.right);
  const selectionCenter = (selectionLeft + selectionRight) / 2 - frameRect.left;
  const left = clamp(selectionCenter - menuWidth / 2, 16, Math.max(16, frameRect.width - menuWidth - 16));
  const selectionTop = Math.min(selectionStart.top, selectionEnd.top) - frameRect.top + scrollTop;
  const topCandidate = selectionTop - SELECTION_MENU_HEIGHT - SELECTION_MENU_GAP;

  if (topCandidate < SELECTION_MENU_GAP) {
    return {
      left,
      selectedText,
      side: "bottom",
      top: selectionTop + SELECTION_LINE_HEIGHT,
    };
  }

  return {
    left,
    selectedText,
    side: "top",
    top: topCandidate,
  };
}

function getFallbackSelectionMenuPosition(selectedText: string): SelectionMenuState {
  return { left: 16, selectedText, side: "top", top: 16 };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
