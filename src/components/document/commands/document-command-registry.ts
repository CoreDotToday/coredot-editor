import type { EditorMessages } from "@/features/i18n/editor-language";
import { getDocumentCommandShortcutLabel } from "@/features/commands/document-command-manifest";
import type { EditorSurface, SaveState } from "../DocumentShell";
import type { DocumentCommandAction } from "./document-command-types";

type DocumentCommandRegistryConfig = {
  editorSurface: EditorSurface;
  hasSaveConflict: boolean;
  isExportingDocx: boolean;
  messages: EditorMessages["commandPalette"];
  saveState: SaveState;
};

export type DocumentCommandDefinition = Omit<DocumentCommandAction, "execute">;

export function buildDocumentCommandRegistry({
  editorSurface,
  hasSaveConflict,
  isExportingDocx,
  messages,
  saveState,
}: DocumentCommandRegistryConfig): DocumentCommandDefinition[] {
  return [
    {
      enabled: true,
      group: "ai",
      id: "open-workspace",
      keywords: ["ai", "workspace", "chat", "review", "대화", "검토"],
      label: messages.commands.openWorkspace,
    },
    {
      enabled: true,
      group: "ai",
      id: "review-document",
      keywords: ["ai", "review", "document", "검토", "리뷰"],
      label: messages.commands.reviewDocument,
    },
    {
      enabled: true,
      group: "view",
      id: "find-document",
      keywords: ["find", "search", "replace", "찾기", "검색", "교체"],
      label: messages.commands.findDocument,
      shortcut: getDocumentCommandShortcutLabel("find-document"),
    },
    {
      enabled: editorSurface !== "source",
      group: "view",
      id: "show-source",
      keywords: ["source", "raw", "json", "markdown", "소스"],
      label: messages.commands.showSource,
    },
    {
      enabled: editorSurface !== "editor",
      group: "view",
      id: "show-editor",
      keywords: ["editor", "write", "edit", "편집"],
      label: messages.commands.showEditor,
    },
    {
      enabled: !hasSaveConflict && saveState !== "saved" && saveState !== "saving",
      group: "document",
      id: "save-document",
      keywords: ["save", "저장"],
      label: messages.commands.save,
    },
    {
      enabled: !isExportingDocx,
      group: "export",
      id: "export-docx",
      keywords: ["docx", "export", "download", "내보내기", "다운로드"],
      label: messages.commands.exportDocx,
    },
  ];
}
