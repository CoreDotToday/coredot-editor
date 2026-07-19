import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { createDocumentSchemaExtensions } from "@/features/documents/tiptap-extensions";
import { getProjectProfile } from "@/features/projects/default-project-profiles";

import {
  createCollaborationEditorExtensions,
  prepareBaseExtensionsForCollaboration,
} from "./collaboration-editor-extensions";

describe("collaboration editor extensions", () => {
  it("disables history and identity-breaking list helpers while preserving the schema", () => {
    const prepared = prepareBaseExtensionsForCollaboration(createDocumentSchemaExtensions());
    const starterKit = prepared.find((extension) => extension.name === "starterKit");

    expect(starterKit).toBeDefined();
    expect(starterKit?.options.undoRedo).toBe(false);
    expect(starterKit?.options.listKeymap).toBe(false);
    expect(prepared.some((extension) => extension.name === "undoRedo")).toBe(false);
    expect(prepared.some((extension) => extension.name === "emptyListItemExit")).toBe(false);
  });

  it("binds Collaboration and CollaborationCaret to the canonical body/provider", () => {
    const document = new Y.Doc();
    const provider = { awareness: new Awareness(document) };

    const extensions = createCollaborationEditorExtensions({ document, provider });

    const collaboration = extensions.find((extension) => extension.name === "collaboration");
    const caret = extensions.find((extension) => extension.name === "collaborationCaret");
    const structuralGuards = extensions.find(
      (extension) => extension.name === "collaborationStructuralGuards",
    );
    expect(collaboration?.options).toMatchObject({ document, field: "body", provider });
    expect(caret?.options.provider).toBe(provider);
    expect(caret?.options.user).toMatchObject({ color: "", displayName: "" });
    expect(structuralGuards).toBeDefined();

    provider.awareness.destroy();
    document.destroy();
  });

  it("blocks list outdent keyboard shortcuts without replacing the collaborative body", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap({
      contentJson: {
        type: "doc",
        content: [{
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
              {
                type: "bulletList",
                content: [{
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Child" }] }],
                }],
              },
            ],
          }],
        }],
      },
      metadataJson: {},
      plainText: "Parent\nChild",
      title: "Keyboard guard",
    });
    const provider = { awareness: new Awareness(document) };
    const editor = new Editor({
      extensions: [
        ...prepareBaseExtensionsForCollaboration(createDocumentSchemaExtensions()),
        ...createCollaborationEditorExtensions({ document, provider }),
      ],
    });
    const before = editor.getJSON();
    const childTextPosition = findTextPosition(editor, "Child");
    expect(editor.state.doc.resolve(childTextPosition).parent.type.name).toBe("paragraph");
    editor.commands.setTextSelection(childTextPosition);

    expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);
    expect(editor.getJSON()).toEqual(before);

    editor.commands.insertContent("LOCAL-");
    const afterLocalEdit = editor.getJSON();
    expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
    expect(editor.commands.keyboardShortcut("Shift-Mod-z")).toBe(true);
    expect(editor.getJSON()).toEqual(afterLocalEdit);

    editor.destroy();
    provider.awareness.destroy();
    document.destroy();
  });
});

function findTextPosition(editor: Editor, text: string) {
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text)) position = pos;
  });
  if (position === null) throw new Error(`Missing text in editor: ${text}`);
  return position;
}
