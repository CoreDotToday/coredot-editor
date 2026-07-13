import { Extension } from "@tiptap/core";
import { MarkdownPaste } from "@/features/documents/markdown-paste";
import {
  createEditorSchemaExtensions,
  defaultDocumentSchemaProfile,
  type DocumentSchemaProfile,
} from "../document-schema-profile";
import type { EditorPlugin } from "../types";

export const coreDocumentPlugin = createCoreDocumentPlugin(defaultDocumentSchemaProfile);

export function createCoreDocumentPlugin(profile: DocumentSchemaProfile): EditorPlugin {
  return {
    id: "core.document",
    name: "Core document schema",
    tiptapExtensions: () => createCoreDocumentExtensions(profile),
    version: "0.1.0",
  };
}

export function createCoreDocumentExtensions(profile: DocumentSchemaProfile = defaultDocumentSchemaProfile) {
  return [
    ...createEditorSchemaExtensions(profile),
    MarkdownPaste,
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
