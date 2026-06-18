import { describe, expect, it, vi } from "vitest";
import { getDocumentCommandRegistryIds } from "@/features/commands/document-command-manifest";
import { editorMessages } from "@/features/i18n/editor-language";
import { buildDocumentCommandRegistry } from "./document-command-registry";

function buildRegistry() {
  return buildDocumentCommandRegistry({
    editorSurface: "editor",
    exportDocxDraft: vi.fn(),
    isExportingDocx: false,
    messages: editorMessages.ko.commandPalette,
    openFind: vi.fn(),
    runDocumentReview: vi.fn(),
    saveDraft: vi.fn(),
    saveState: "dirty",
    setEditorSurface: vi.fn(),
    setWorkspaceOpen: vi.fn(),
  });
}

describe("buildDocumentCommandRegistry", () => {
  it("keeps palette action ids aligned with the command manifest", () => {
    expect(buildRegistry().map((action) => action.id)).toEqual(getDocumentCommandRegistryIds());
  });
});
