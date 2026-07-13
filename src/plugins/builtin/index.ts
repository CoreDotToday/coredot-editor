import { aiWritingPlugin } from "./ai-writing-plugin";
import { createCoreDocumentPlugin } from "./core-document-plugin";
import { slashMenuPlugin } from "./slash-menu-plugin";
import { defaultDocumentSchemaProfile, type DocumentSchemaProfile } from "../document-schema-profile";

export const builtinEditorPlugins = createBuiltinEditorPlugins(defaultDocumentSchemaProfile);

export function createBuiltinEditorPlugins(schemaProfile: DocumentSchemaProfile) {
  return [createCoreDocumentPlugin(schemaProfile), aiWritingPlugin, slashMenuPlugin];
}

export { aiWritingPlugin } from "./ai-writing-plugin";
export { coreDocumentPlugin } from "./core-document-plugin";
export { slashMenuPlugin } from "./slash-menu-plugin";
