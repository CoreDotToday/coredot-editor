import { createBuiltinEditorPlugins } from "./builtin";
import { appDocumentSchemaProfileRuntime } from "./app-document-schema-profile-runtime.mjs";
import type { DocumentSchemaProfile } from "./document-schema-profile";
import type { EditorPlugin } from "./types";

export const appDocumentSchemaProfile: DocumentSchemaProfile = appDocumentSchemaProfileRuntime;

export const appEditorPlugins: EditorPlugin[] = [];

type CreateAppEditorPluginsOptions = {
  appPlugins?: EditorPlugin[];
  schemaProfile?: DocumentSchemaProfile;
};

export function createAppEditorPlugins({
  appPlugins = appEditorPlugins,
  schemaProfile = appDocumentSchemaProfile,
}: CreateAppEditorPluginsOptions = {}): EditorPlugin[] {
  return [
    ...createBuiltinEditorPlugins(schemaProfile),
    ...appPlugins,
  ];
}

export const defaultEditorPlugins: EditorPlugin[] = createAppEditorPlugins();
