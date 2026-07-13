import type { AnyExtension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import type { TiptapJson } from "@/db/schema";
import type { EditorLanguage, EditorMessages } from "@/features/i18n/editor-language";

export type EditorPluginContext = {
  enabledPluginIds: string[];
  featureFlags: Record<string, boolean>;
  language: EditorLanguage;
  messages: EditorMessages;
};

export type EditorSelectionCommandIcon = "bar-chart" | "languages" | "minimize" | "pen-line" | "sparkles" | "wand";
export type EditorSelectionApplyMode = "insert_below" | "replace";
export type EditorSelectionCommandMetadata = {
  defaultApplyMode: EditorSelectionApplyMode;
  id?: string;
};

export type EditorSelectionCommand = {
  ariaLabel: string;
  command: string;
  defaultApplyMode?: EditorSelectionApplyMode;
  icon: EditorSelectionCommandIcon;
  id: string;
  label: string;
};

export type EditorSlashCommandRange = {
  from: number;
  to: number;
};

export type EditorSlashCommandGroup = "ai" | "blocks" | "lists" | "style";

export type EditorSlashCommandIcon =
  | "check-square"
  | "code"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "list"
  | "list-ordered"
  | "minus"
  | "quote"
  | "sparkles"
  | "type";

export type EditorSlashCommand = {
  aliases: string[];
  command: (editor: Editor, range: EditorSlashCommandRange) => void;
  group: EditorSlashCommandGroup;
  icon: EditorSlashCommandIcon;
  id: string;
  label: string;
  searchText: string;
  subtext: string;
};

export type EditorToolbarItem = {
  id: string;
  isEnabled?: (context: EditorHostContext) => boolean;
  label: string;
  run: (context: EditorHostContext) => void;
};

export type EditorBlockAction = {
  id: string;
  isEnabled?: (context: EditorBlockHostContext) => boolean;
  label: string;
  run: (context: EditorBlockHostContext) => void;
};

export type EditorWorkspacePanel = {
  id: string;
  label: string;
  render: (context: EditorWorkspaceHostContext) => ReactNode;
};

export type EditorSettingsSection = {
  id: string;
  label: string;
  render: (context: EditorSettingsHostContext) => ReactNode;
};

export type EditorHostContext = {
  editor: Editor;
  language: EditorLanguage;
  messages: EditorMessages;
};

export type EditorBlockHostContext = EditorHostContext & {
  block: {
    from: number;
    kind: "listItem" | "topLevel";
    listItemPath?: number[];
    to: number;
    topLevelIndex: number;
  };
};

export type EditorWorkspaceHostContext = {
  document: {
    contentJson: TiptapJson;
    id: string;
    plainText: string;
    title: string;
  };
  language: EditorLanguage;
  messages: EditorMessages;
};

export type EditorSettingsHostContext = {
  language: EditorLanguage;
  messages: EditorMessages;
};

export type EditorPluginContributions = {
  blockActions: EditorBlockAction[];
  selectionCommands: EditorSelectionCommand[];
  settingsSections: EditorSettingsSection[];
  slashCommands: EditorSlashCommand[];
  tiptapExtensions: AnyExtension[];
  toolbarItems: EditorToolbarItem[];
  workspacePanels: EditorWorkspacePanel[];
};

export type EditorPlugin = {
  blockActions?: (context: EditorPluginContext) => EditorBlockAction[];
  dependencies?: string[];
  id: string;
  name: string;
  selectionCommands?: (context: EditorPluginContext) => EditorSelectionCommand[];
  settingsSections?: (context: EditorPluginContext) => EditorSettingsSection[];
  slashCommands?: (context: EditorPluginContext) => EditorSlashCommand[];
  tiptapExtensions?: (context: EditorPluginContext) => AnyExtension[];
  toolbarItems?: (context: EditorPluginContext) => EditorToolbarItem[];
  version: string;
  workspacePanels?: (context: EditorPluginContext) => EditorWorkspacePanel[];
};

export function createEmptyEditorPluginContributions(): EditorPluginContributions {
  return {
    blockActions: [],
    selectionCommands: [],
    settingsSections: [],
    slashCommands: [],
    tiptapExtensions: [],
    toolbarItems: [],
    workspacePanels: [],
  };
}
