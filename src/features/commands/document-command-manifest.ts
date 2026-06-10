import type { DocumentCommandGroup } from "@/components/document/commands/document-command-types";

type DocumentShortcutDefinition = {
  display: string;
  key: string;
  modifier: "mod";
};

export type DocumentCommandManifestItem = {
  group: DocumentCommandGroup;
  id: string;
  shortcut?: DocumentShortcutDefinition;
};

export const documentCommandManifest = [
  {
    group: "view",
    id: "open-command-palette",
    shortcut: {
      display: "⌘K",
      key: "k",
      modifier: "mod",
    },
  },
  {
    group: "ai",
    id: "open-workspace",
  },
  {
    group: "ai",
    id: "review-document",
  },
  {
    group: "view",
    id: "find-document",
    shortcut: {
      display: "⌘F",
      key: "f",
      modifier: "mod",
    },
  },
  {
    group: "view",
    id: "show-source",
  },
  {
    group: "view",
    id: "show-editor",
  },
  {
    group: "document",
    id: "save-document",
  },
  {
    group: "export",
    id: "export-docx",
  },
] as const satisfies readonly DocumentCommandManifestItem[];

export type DocumentCommandId = (typeof documentCommandManifest)[number]["id"];

const commandById = new Map<DocumentCommandId, (typeof documentCommandManifest)[number]>(
  documentCommandManifest.map((command) => [command.id, command]),
);

export function getDocumentCommandShortcutLabel(commandId: DocumentCommandId): string | undefined {
  const command = commandById.get(commandId);
  return hasDocumentShortcut(command) ? command.shortcut.display : undefined;
}

export function resolveDocumentShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): DocumentCommandId | null {
  if (event.altKey || event.shiftKey) {
    return null;
  }

  const hasMod = event.metaKey || event.ctrlKey;
  if (!hasMod) {
    return null;
  }

  const key = event.key.toLowerCase();
  const command = documentCommandManifest.find((item) => {
    if (!hasDocumentShortcut(item)) {
      return false;
    }

    return item.shortcut.modifier === "mod" && item.shortcut.key === key;
  });

  return command?.id ?? null;
}

function hasDocumentShortcut(
  command: (typeof documentCommandManifest)[number] | undefined,
): command is (typeof documentCommandManifest)[number] & { shortcut: DocumentShortcutDefinition } {
  return Boolean(command && "shortcut" in command);
}
