import type { AnyExtension } from "@tiptap/core";
import type {} from "@tiptap/extension-link";
import type {} from "@tiptap/extension-table";
import type {} from "@tiptap/extension-task-item";
import type {} from "@tiptap/extension-task-list";
import type {} from "@tiptap/extension-typography";
import type {} from "@tiptap/starter-kit";
import {
  createEditorSchemaExtensionsRuntime,
  createServerSchemaExtensionsRuntime,
  defaultDocumentSchemaProfileRuntime,
} from "./document-schema-profile-runtime.mjs";

export type DocumentSchemaProfile = {
  id: string;
  extensions: () => AnyExtension[];
};

export const defaultDocumentSchemaProfile: DocumentSchemaProfile = defaultDocumentSchemaProfileRuntime;

export function createEditorSchemaExtensions(
  profile: DocumentSchemaProfile = defaultDocumentSchemaProfile,
): AnyExtension[] {
  return createEditorSchemaExtensionsRuntime(profile);
}

export function createServerSchemaExtensions(
  profile: DocumentSchemaProfile = defaultDocumentSchemaProfile,
): AnyExtension[] {
  return createServerSchemaExtensionsRuntime(profile);
}
