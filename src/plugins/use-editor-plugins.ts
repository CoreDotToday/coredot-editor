"use client";

import { useMemo } from "react";
import { editorMessages, type EditorLanguage } from "@/features/i18n/editor-language";
import { defaultEditorPlugins } from "./app-plugins";
import { createEditorPluginRegistry } from "./registry";
import { createEmptyEditorPluginContributions, type EditorPlugin } from "./types";

type UseEditorPluginsOptions = {
  disabledPluginIds?: string[];
  featureFlags?: Record<string, boolean>;
  plugins?: EditorPlugin[];
  resolve?: boolean;
};

const EMPTY_DISABLED_PLUGIN_IDS: string[] = [];
const EMPTY_FEATURE_FLAGS: Record<string, boolean> = {};

export function useEditorPlugins(language: EditorLanguage, options: UseEditorPluginsOptions = {}) {
  const plugins = options.plugins ?? defaultEditorPlugins;
  const shouldResolve = options.resolve ?? true;
  const featureFlags = options.featureFlags ?? EMPTY_FEATURE_FLAGS;
  const disabledPluginIds = options.disabledPluginIds ?? EMPTY_DISABLED_PLUGIN_IDS;

  return useMemo(() => {
    if (!shouldResolve) return createEmptyEditorPluginContributions();
    const registry = createEditorPluginRegistry(plugins, { disabledPluginIds, featureFlags });
    return registry.resolve({ language, messages: editorMessages[language] });
  }, [disabledPluginIds, featureFlags, language, plugins, shouldResolve]);
}
