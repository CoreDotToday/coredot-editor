import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import StarterKit from "@tiptap/starter-kit";

/**
 * The runtime schema is deliberately React-free so the editor and isolated
 * document conversion worker can share one source of truth.
 */
export const defaultDocumentSchemaProfileRuntime = Object.freeze({
  id: "core.document.v1",
  extensions: createDefaultDocumentSchemaExtensions,
});

export function createEditorSchemaExtensionsRuntime(profile = defaultDocumentSchemaProfileRuntime) {
  return profile.extensions();
}

export function createServerSchemaExtensionsRuntime(profile = defaultDocumentSchemaProfileRuntime) {
  return profile.extensions();
}

function createDefaultDocumentSchemaExtensions() {
  return [
    StarterKit.configure({ link: false }),
    Link.configure({ autolink: true, openOnClick: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Typography,
  ];
}
