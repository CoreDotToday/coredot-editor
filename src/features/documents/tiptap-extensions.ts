import { DEFAULT_EDITOR_LANGUAGE, editorMessages } from "@/features/i18n/editor-language";
import { coreDocumentPlugin } from "@/plugins/builtin/core-document-plugin";

export function createDocumentSchemaExtensions() {
  return (
    coreDocumentPlugin.tiptapExtensions?.({
      enabledPluginIds: [coreDocumentPlugin.id],
      featureFlags: {},
      language: DEFAULT_EDITOR_LANGUAGE,
      messages: editorMessages[DEFAULT_EDITOR_LANGUAGE],
    }) ?? []
  );
}
