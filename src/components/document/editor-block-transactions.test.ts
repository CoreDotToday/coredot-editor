import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TiptapJson } from "@/db/schema";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { createDocumentBlockLocation } from "@/features/documents/block-movement";
import { createDocumentSchemaExtensions } from "@/features/documents/tiptap-extensions";
import { getProjectProfile } from "@/features/projects/default-project-profiles";

import {
  applyScopedBlockMove,
  applyScopedLastBlockDeletion,
  applyScopedListItemConversion,
  applyScopedOutdent,
} from "./editor-block-transactions";
import {
  getListItemBlockActionRangeByPath,
  getTopLevelBlockActionRangeByIndex,
} from "./editor-block-ranges";

const editors: Editor[] = [];
const documents: Y.Doc[] = [];

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  while (documents.length > 0) documents.pop()?.destroy();
});

describe("scoped collaborative block transactions", () => {
  it.each([
    ["bold", "toggleBold"],
    ["italic", "toggleItalic"],
    ["strike", "toggleStrike"],
    ["code", "toggleCode"],
  ] as const)("preserves concurrent text while applying the %s inline mark", (mark, command) => {
    const peers = createPeers(paragraphDocument("Alpha"));
    const localRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));
    const remoteRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.remote, 0));
    peers.local.commands.setTextSelection({ from: localRange.from + 1, to: localRange.from + 6 });
    expect(peers.local.commands[command]()).toBe(true);
    peers.remote.commands.insertContentAt(remoteRange.from + 1, "REMOTE-");
    peers.exchange();

    expect(peers.local.getJSON()).toEqual(peers.remote.getJSON());
    expect(peers.local.getText()).toContain("REMOTE-Alpha");
    expect(findTextNodeMarks(peers.local.getJSON(), "Alpha")).toContain(mark);
  });

  it("preserves a concurrent remote insertion during drag/drop", () => {
    const peers = createPeers(paragraphDocument("Alpha", "Bravo", "Charlie"));
    const setContent = vi.spyOn(peers.local.commands, "setContent");
    const sourceRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));
    const source = requiredLocation(createDocumentBlockLocation(sourceRange));

    expect(applyScopedBlockMove(peers.local, {
      source,
      target: { index: 3, kind: "topLevelSlot" },
    })).toBeNull();
    peers.remote.commands.insertContentAt(0, paragraph("Remote drag insertion"));
    peers.exchange();

    expectConvergedWithText(peers, "Remote drag insertion", "Alpha", "Bravo", "Charlie");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("keeps a concurrent edit attached to the block being moved", () => {
    const peers = createPeers(paragraphDocument("Alpha", "Bravo", "Charlie"));
    const sourceRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));
    const source = requiredLocation(createDocumentBlockLocation(sourceRange));

    expect(applyScopedBlockMove(peers.local, {
      source,
      target: { index: 3, kind: "topLevelSlot" },
    })).toBeNull();
    const remoteSourceRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.remote, 0));
    peers.remote.commands.insertContentAt(remoteSourceRange.from + 1, "REMOTE-");
    peers.exchange();

    expect(peers.local.getJSON()).toEqual(paragraphDocument("REMOTE-Alpha", "Bravo", "Charlie"));
    expect(peers.remote.getJSON()).toEqual(peers.local.getJSON());
  });

  it("preserves a concurrent remote insertion during relative block movement", () => {
    const peers = createPeers(paragraphDocument("Alpha", "Bravo", "Charlie"));
    const sourceRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 1));
    const source = requiredLocation(createDocumentBlockLocation(sourceRange));

    expect(applyScopedBlockMove(peers.local, {
      source,
      target: { direction: "down", kind: "relative" },
    })).toBeNull();
    peers.remote.commands.insertContentAt(
      peers.remote.state.doc.content.size,
      paragraph("Remote move insertion"),
    );
    peers.exchange();

    expectConvergedWithText(peers, "Remote move insertion", "Alpha", "Bravo", "Charlie");
  });

  it("preserves a concurrent remote insertion when deleting the final local block", () => {
    const peers = createPeers(paragraphDocument("Only local block"));
    const setContent = vi.spyOn(peers.local.commands, "setContent");
    const range = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));

    expect(applyScopedLastBlockDeletion(peers.local, range, peers.localDocument)).toBe(true);
    expect(peers.local.getText()).not.toContain("Only");
    peers.remote.commands.insertContentAt(
      peers.remote.state.doc.content.size,
      paragraph("Remote survivor"),
    );
    peers.exchange();

    expectConvergedWithText(peers, "Remote survivor");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("does not resurrect deleted text when the final block receives a concurrent edit", () => {
    const peers = createPeers(paragraphDocument("Only"));
    const range = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));

    expect(applyScopedLastBlockDeletion(peers.local, range, peers.localDocument)).toBe(true);
    const remoteRange = requiredRange(getTopLevelBlockActionRangeByIndex(peers.remote, 0));
    peers.remote.commands.insertContentAt(remoteRange.from + 1, "REMOTE-");
    peers.exchange();

    expect(peers.local.getJSON()).toEqual(paragraphDocument("REMOTE-"));
    expect(peers.remote.getJSON()).toEqual(peers.local.getJSON());
  });

  it("fails closed when the final collaborative block cannot be cleared as text", () => {
    const peers = createPeers({ content: [{ type: "horizontalRule" }], type: "doc" });
    const range = requiredRange(getTopLevelBlockActionRangeByIndex(peers.local, 0));
    const before = peers.local.getJSON();

    expect(applyScopedLastBlockDeletion(peers.local, range, peers.localDocument)).toBe(false);
    expect(peers.local.getJSON()).toEqual(before);
  });

  it("preserves a concurrent remote insertion while converting a list item to text", () => {
    const peers = createPeers(listDocument("One", "Two"));
    const setContent = vi.spyOn(peers.local.commands, "setContent");
    const range = requiredRange(getListItemBlockActionRangeByPath(peers.local, 0, [0]));

    expect(applyScopedListItemConversion(peers.local, range)).toBeNull();
    peers.remote.commands.insertContentAt(
      peers.remote.state.doc.content.size,
      paragraph("Remote list insertion"),
    );
    expect(peers.remote.getText()).toContain("Remote list insertion");
    peers.exchange();

    expectConvergedWithText(peers, "Remote list insertion", "One", "Two");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("keeps a concurrent edit attached to the list item being converted to text", () => {
    const peers = createPeers(listDocument("One", "Two"));
    const localRange = requiredRange(getListItemBlockActionRangeByPath(peers.local, 0, [0]));

    expect(applyScopedListItemConversion(peers.local, localRange)).toBeNull();
    const remoteRange = requiredRange(getListItemBlockActionRangeByPath(peers.remote, 0, [0]));
    peers.remote.commands.insertContentAt(remoteRange.from + 2, "REMOTE-");
    peers.exchange();

    expect(peers.local.getText()).toContain("REMOTE-One");
    expect(peers.remote.getJSON()).toEqual(peers.local.getJSON());
  });

  it("preserves a concurrent remote insertion while outdenting a list item", () => {
    const peers = createPeers(nestedListDocument());
    const setContent = vi.spyOn(peers.local.commands, "setContent");
    const range = requiredRange(getListItemBlockActionRangeByPath(peers.local, 0, [0, 0, 1]));

    expect(applyScopedOutdent(peers.local, range)).toBeNull();
    const remoteRange = requiredRange(getListItemBlockActionRangeByPath(peers.remote, 0, [0, 0, 0]));
    insertListItemAt(peers.remote, remoteRange.to, "Remote outdent insertion");
    peers.exchange();

    expectConvergedWithText(peers, "Remote outdent insertion", "One", "Two", "Three");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("keeps a concurrent edit attached to the list item being outdented", () => {
    const peers = createPeers(nestedListDocument());
    const localRange = requiredRange(getListItemBlockActionRangeByPath(peers.local, 0, [0, 0, 1]));

    expect(applyScopedOutdent(peers.local, localRange)).toBeNull();
    const remoteRange = requiredRange(getListItemBlockActionRangeByPath(peers.remote, 0, [0, 0, 1]));
    peers.remote.commands.insertContentAt(remoteRange.from + 2, "REMOTE-");
    peers.exchange();

    expect(peers.local.getText()).toContain("REMOTE-Two");
    expect(peers.remote.getJSON()).toEqual(peers.local.getJSON());
  });

  it("retains legacy structural block movement when no Yjs binding is active", () => {
    const editor = new Editor({
      content: paragraphDocument("Alpha", "Bravo", "Charlie") as JSONContent,
      extensions: createDocumentSchemaExtensions(),
    });
    editors.push(editor);
    const range = requiredRange(getTopLevelBlockActionRangeByIndex(editor, 0));
    const source = requiredLocation(createDocumentBlockLocation(range));

    expect(applyScopedBlockMove(editor, {
      source,
      target: { index: 3, kind: "topLevelSlot" },
    })).toMatchObject({ kind: "topLevel", path: [2] });
    expect(editor.getJSON()).toEqual(paragraphDocument("Bravo", "Charlie", "Alpha"));
  });
});

function createPeers(contentJson: TiptapJson) {
  const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
  const canonical = codec.bootstrap({ contentJson, metadataJson: {}, plainText: "", title: "Test" });
  const localDocument = new Y.Doc();
  const remoteDocument = new Y.Doc();
  Y.applyUpdate(localDocument, Y.encodeStateAsUpdate(canonical));
  Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(canonical));
  canonical.destroy();
  documents.push(localDocument, remoteDocument);

  const extensions = () => [
    ...createDocumentSchemaExtensions().filter((extension) => extension.name !== "undoRedo"),
    Collaboration.configure({ document: localDocument, field: "body" }),
  ];
  const local = new Editor({ extensions: extensions() });
  const remoteExtensions = [
    ...createDocumentSchemaExtensions().filter((extension) => extension.name !== "undoRedo"),
    Collaboration.configure({ document: remoteDocument, field: "body" }),
  ];
  const remote = new Editor({ extensions: remoteExtensions });
  editors.push(local, remote);

  const localUpdates: Uint8Array[] = [];
  const remoteUpdates: Uint8Array[] = [];
  localDocument.on("update", (update, origin) => {
    if (origin !== "remote-test") localUpdates.push(update);
  });
  remoteDocument.on("update", (update, origin) => {
    if (origin !== "remote-test") remoteUpdates.push(update);
  });

  return {
    exchange() {
      for (const update of localUpdates.splice(0)) Y.applyUpdate(remoteDocument, update, "remote-test");
      for (const update of remoteUpdates.splice(0)) Y.applyUpdate(localDocument, update, "remote-test");
    },
    local,
    localDocument,
    remote,
  };
}

function expectConvergedWithText(
  peers: ReturnType<typeof createPeers>,
  ...expectedText: string[]
) {
  expect(peers.local.getJSON()).toEqual(peers.remote.getJSON());
  for (const text of expectedText) {
    expect(peers.local.getText()).toContain(text);
  }
}

function paragraphDocument(...text: string[]): TiptapJson {
  return { content: text.map((value) => paragraph(value)), type: "doc" };
}

function findTextNodeMarks(document: JSONContent, text: string) {
  const marks: string[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "text" && node.text?.includes(text)) {
      marks.push(...(node.marks ?? []).map((mark) => mark.type));
    }
    node.content?.forEach(visit);
  };
  visit(document);
  return marks;
}

function listDocument(...text: string[]): TiptapJson {
  return {
    content: [{ content: text.map((value) => listItem(value)), type: "bulletList" }],
    type: "doc",
  };
}

function nestedListDocument(): TiptapJson {
  return {
    content: [{
      content: [{
        content: [
          paragraph("Parent"),
          { content: [listItem("One"), listItem("Two"), listItem("Three")], type: "bulletList" },
        ],
        type: "listItem",
      }],
      type: "bulletList",
    }],
    type: "doc",
  };
}

function paragraph(text: string) {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function listItem(text: string) {
  return { content: [paragraph(text)], type: "listItem" };
}

function insertListItemAt(editor: Editor, position: number, text: string) {
  const node = editor.state.schema.nodeFromJSON(listItem(text));
  editor.view.dispatch(editor.state.tr.insert(position, node));
}

function requiredRange<T>(value: T | null): T {
  if (!value) throw new Error("Expected block range");
  return value;
}

function requiredLocation<T>(value: T | null): T {
  if (!value) throw new Error("Expected block location");
  return value;
}
