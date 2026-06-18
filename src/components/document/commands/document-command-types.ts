import type { DocumentCommandGroup, DocumentCommandId } from "@/features/commands/document-command-manifest";

export type { DocumentCommandGroup };

export type DocumentCommandAction = {
  enabled?: boolean;
  execute: () => void;
  group: DocumentCommandGroup;
  id: DocumentCommandId;
  keywords: string[];
  label: string;
  shortcut?: string;
};

export type DocumentCommandPaletteMessages = {
  empty: string;
  footerHint: string;
  groups: Record<DocumentCommandGroup, string>;
  placeholder: string;
  searchLabel: string;
  title: string;
};
