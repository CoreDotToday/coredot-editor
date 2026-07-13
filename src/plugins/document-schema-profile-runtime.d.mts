import type { AnyExtension } from "@tiptap/core";

export type DocumentSchemaProfileRuntime = {
  id: string;
  extensions: () => AnyExtension[];
};

export const defaultDocumentSchemaProfileRuntime: DocumentSchemaProfileRuntime;
export function createEditorSchemaExtensionsRuntime(profile?: DocumentSchemaProfileRuntime): AnyExtension[];
export function createServerSchemaExtensionsRuntime(profile?: DocumentSchemaProfileRuntime): AnyExtension[];
