export type DocumentCommandGroup = "ai" | "document" | "export" | "view";

export type DocumentCommandAction = {
  enabled?: boolean;
  execute: () => void;
  group: DocumentCommandGroup;
  id: string;
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
