import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownPaste } from "@/features/documents/markdown-paste";
import type { EditorPlugin } from "../types";

export const coreDocumentPlugin: EditorPlugin = {
  id: "core.document",
  name: "Core document schema",
  tiptapExtensions: createCoreDocumentExtensions,
  version: "0.1.0",
};

export function createCoreDocumentExtensions() {
  return [
    StarterKit.configure({
      link: false,
    }),
    Link.configure({
      autolink: true,
      openOnClick: false,
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    TableKit.configure({
      table: {
        resizable: true,
      },
    }),
    MarkdownPaste,
    Typography,
    EmptyListItemExit,
  ];
}

const EmptyListItemExit = Extension.create({
  name: "emptyListItemExit",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection } = this.editor.state;
        if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.textContent.length > 0) {
          return false;
        }

        const listItemType = findActiveListItemType(selection.$from);
        if (!listItemType) {
          return false;
        }

        const commands = this.editor.commands as unknown as Record<string, (...commandArgs: unknown[]) => boolean>;
        return commands.liftListItem?.(listItemType) ?? false;
      },
    };
  },
});

function findActiveListItemType($from: { depth: number; node: (depth: number) => { type: { name: string } } }) {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name;
    if (nodeName === "listItem" || nodeName === "taskItem") {
      return nodeName;
    }
  }

  return null;
}
