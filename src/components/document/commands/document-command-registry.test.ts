import { describe, expect, it } from "vitest";
import { getDocumentCommandRegistryIds } from "@/features/commands/document-command-manifest";
import { editorMessages } from "@/features/i18n/editor-language";
import { buildDocumentCommandRegistry } from "./document-command-registry";

function buildRegistry() {
  return buildDocumentCommandRegistry({
    editorSurface: "editor",
    hasSaveConflict: false,
    isExportingDocx: false,
    messages: editorMessages.ko.commandPalette,
    saveState: "dirty",
  });
}

describe("buildDocumentCommandRegistry", () => {
  it("keeps palette action ids aligned with the command manifest", () => {
    expect(buildRegistry().map((action) => action.id)).toEqual(getDocumentCommandRegistryIds());
  });

  it("disables save while a revision conflict requires an explicit recovery choice", () => {
    const registry = buildDocumentCommandRegistry({
      editorSurface: "editor",
      hasSaveConflict: true,
      isExportingDocx: false,
      messages: editorMessages.ko.commandPalette,
      saveState: "failed",
    });

    expect(registry.find((action) => action.id === "save-document")?.enabled).toBe(false);
  });
});
