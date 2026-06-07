import { aiWritingPlugin } from "./ai-writing-plugin";
import { coreDocumentPlugin } from "./core-document-plugin";
import { slashMenuPlugin } from "./slash-menu-plugin";

export const builtinEditorPlugins = [coreDocumentPlugin, aiWritingPlugin, slashMenuPlugin];

export { aiWritingPlugin } from "./ai-writing-plugin";
export { coreDocumentPlugin } from "./core-document-plugin";
export { slashMenuPlugin } from "./slash-menu-plugin";
