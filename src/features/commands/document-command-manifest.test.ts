import { describe, expect, it } from "vitest";
import {
  documentCommandManifest,
  getDocumentCommandShortcutLabel,
  resolveDocumentShortcut,
} from "./document-command-manifest";

function keyboardEvent(init: Partial<KeyboardEvent>) {
  return {
    altKey: false,
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("document command manifest", () => {
  it("uses unique command ids", () => {
    const ids = documentCommandManifest.map((command) => command.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves document-level shortcuts", () => {
    expect(resolveDocumentShortcut(keyboardEvent({ key: "k", metaKey: true }))).toBe("open-command-palette");
    expect(resolveDocumentShortcut(keyboardEvent({ key: "f", ctrlKey: true }))).toBe("find-document");
    expect(resolveDocumentShortcut(keyboardEvent({ key: "f", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("returns localized shortcut labels for palette display", () => {
    expect(getDocumentCommandShortcutLabel("open-command-palette")).toBe("⌘K");
    expect(getDocumentCommandShortcutLabel("find-document")).toBe("⌘F");
    expect(getDocumentCommandShortcutLabel("review-document")).toBeUndefined();
  });
});
