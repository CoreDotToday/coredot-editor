import { builtinEditorPlugins } from "./builtin";
import type { EditorPlugin } from "./types";

export const appEditorPlugins: EditorPlugin[] = [];

export const defaultEditorPlugins: EditorPlugin[] = [...builtinEditorPlugins, ...appEditorPlugins];
