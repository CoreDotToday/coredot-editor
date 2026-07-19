"use client";

import { Extension, type AnyExtension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

export type CollaborationEditorProvider = {
  awareness: Awareness;
};

export type CollaborationEditorBinding = {
  document: Y.Doc;
  provider: CollaborationEditorProvider;
};

export function prepareBaseExtensionsForCollaboration(
  extensions: readonly AnyExtension[],
): AnyExtension[] {
  return extensions.flatMap((extension) => {
    if (extension.name === "undoRedo" || extension.name === "emptyListItemExit") return [];
    if (extension.name === "starterKit") {
      return [extension.configure({ listKeymap: false, undoRedo: false })];
    }
    return [extension];
  });
}

export function createCollaborationEditorExtensions(
  binding: CollaborationEditorBinding,
): AnyExtension[] {
  return [
    Collaboration.configure({
      document: binding.document,
      field: "body",
      provider: binding.provider,
    }),
    CollaborationCaret.configure({
      provider: binding.provider,
      // The sidecar replaces these untrusted placeholders with server-owned
      // identity. Task 8 renders the full participant surface.
      user: { color: "", displayName: "" },
      render: renderServerOwnedCaret,
    }),
    CollaborationStructuralGuards,
  ];
}

const CollaborationStructuralGuards = Extension.create({
  name: "collaborationStructuralGuards",
  priority: 2_000,

  addKeyboardShortcuts() {
    const blockStructuralShortcut = () => true;
    const blockListBoundaryShortcut = (boundary: "start" | "end") => {
      const { selection } = this.editor.state;
      if (!selection.empty || !findActiveListItem(selection.$from)) return false;
      return boundary === "start"
        ? selection.$from.parentOffset === 0
        : selection.$from.parentOffset === selection.$from.parent.content.size;
    };

    return {
      Backspace: () => blockListBoundaryShortcut("start"),
      Delete: () => blockListBoundaryShortcut("end"),
      Enter: () => {
        const { selection } = this.editor.state;
        return selection.empty
          && Boolean(findActiveListItem(selection.$from))
          && selection.$from.parent.isTextblock
          && selection.$from.parent.textContent.length === 0;
      },
      Tab: () => Boolean(findActiveListItem(this.editor.state.selection.$from)),
      "Shift-Tab": () => Boolean(findActiveListItem(this.editor.state.selection.$from)),
      "Mod-Alt-0": blockStructuralShortcut,
      "Mod-Alt-1": blockStructuralShortcut,
      "Mod-Alt-2": blockStructuralShortcut,
      "Mod-Alt-3": blockStructuralShortcut,
      "Mod-Alt-4": blockStructuralShortcut,
      "Mod-Alt-5": blockStructuralShortcut,
      "Mod-Alt-6": blockStructuralShortcut,
      "Mod-z": blockStructuralShortcut,
      "Mod-y": blockStructuralShortcut,
      "Shift-Mod-z": blockStructuralShortcut,
      "Mod-Shift-7": blockStructuralShortcut,
      "Mod-Shift-8": blockStructuralShortcut,
      "Mod-Shift-9": blockStructuralShortcut,
      "Mod-Shift-B": blockStructuralShortcut,
    };
  },
});

function findActiveListItem($from: {
  depth: number;
  node: (depth: number) => { type: { name: string } };
}) {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") return name;
  }
  return null;
}

function renderServerOwnedCaret(user: Record<string, unknown>) {
  const cursor = document.createElement("span");
  cursor.classList.add("collaboration-carets__caret");
  const color = typeof user.color === "string" && /^#[0-9a-f]{6}$/i.test(user.color)
    ? user.color
    : "#64748b";
  cursor.style.borderColor = color;

  const label = document.createElement("span");
  label.classList.add("collaboration-carets__label");
  label.style.backgroundColor = color;
  label.textContent = typeof user.displayName === "string" ? user.displayName : "";
  cursor.append(label);
  return cursor;
}
