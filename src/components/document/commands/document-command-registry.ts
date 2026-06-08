import type { EditorMessages } from "@/features/i18n/editor-language";
import type { EditorSurface, SaveState } from "../DocumentShell";
import type { DocumentCommandAction } from "./document-command-types";

type DocumentCommandRegistryConfig = {
  editorSurface: EditorSurface;
  exportDocxDraft: () => void;
  isExportingDocx: boolean;
  messages: EditorMessages["commandPalette"];
  runDocumentReview: () => void;
  saveDraft: () => void;
  saveState: SaveState;
  setEditorSurface: (surface: EditorSurface) => void;
  setWorkspaceOpen: (isOpen: boolean) => void;
};

export function buildDocumentCommandRegistry({
  editorSurface,
  exportDocxDraft,
  isExportingDocx,
  messages,
  runDocumentReview,
  saveDraft,
  saveState,
  setEditorSurface,
  setWorkspaceOpen,
}: DocumentCommandRegistryConfig): DocumentCommandAction[] {
  return [
    {
      enabled: true,
      execute: () => {
        setWorkspaceOpen(true);
      },
      group: "ai",
      id: "open-workspace",
      keywords: ["ai", "workspace", "chat", "review", "대화", "검토"],
      label: messages.commands.openWorkspace,
    },
    {
      enabled: true,
      execute: () => {
        setWorkspaceOpen(true);
        runDocumentReview();
      },
      group: "ai",
      id: "review-document",
      keywords: ["ai", "review", "document", "검토", "리뷰"],
      label: messages.commands.reviewDocument,
    },
    {
      enabled: editorSurface !== "source",
      execute: () => setEditorSurface("source"),
      group: "view",
      id: "show-source",
      keywords: ["source", "raw", "json", "markdown", "소스"],
      label: messages.commands.showSource,
    },
    {
      enabled: editorSurface !== "editor",
      execute: () => setEditorSurface("editor"),
      group: "view",
      id: "show-editor",
      keywords: ["editor", "write", "edit", "편집"],
      label: messages.commands.showEditor,
    },
    {
      enabled: saveState !== "saved" && saveState !== "saving",
      execute: saveDraft,
      group: "document",
      id: "save-document",
      keywords: ["save", "저장"],
      label: messages.commands.save,
    },
    {
      enabled: !isExportingDocx,
      execute: exportDocxDraft,
      group: "export",
      id: "export-docx",
      keywords: ["docx", "export", "download", "내보내기", "다운로드"],
      label: messages.commands.exportDocx,
    },
  ];
}
