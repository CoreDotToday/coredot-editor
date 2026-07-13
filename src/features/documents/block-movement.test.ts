import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TiptapJson } from "@/db/schema";
import {
  createDocumentBlockLocation,
  createDocumentBlockMoveTarget,
  getDocumentBlockSignature,
  moveDocumentBlock,
} from "./block-movement";

describe("moveDocumentBlock", () => {
  it("returns changed content and the resolved cross-list destination", () => {
    const document = listDocument(["A", "B"], ["C", "D"]);

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 1] },
      target: { kind: "listItem", path: [1, 0], placement: "after" },
    });

    expect(result).toMatchObject({
      changed: true,
      destination: { kind: "listItem", path: [1, 1] },
    });
  });

  it("classifies a same-slot move without cloning or mutating the document", () => {
    const document = paragraphDocument("A", "B");
    const snapshot = structuredClone(document);

    const result = moveDocumentBlock(document, {
      source: { kind: "topLevel", path: [0] },
      target: { kind: "topLevel", path: [1], placement: "before" },
    });

    expect(result).toEqual({ changed: false, reason: "same_slot" });
    expect(document).toEqual(snapshot);
  });

  it("rejects a drag intent when the document signature is stale", () => {
    const original = paragraphDocument("A", "B");
    const current = paragraphDocument("A changed", "B");

    const result = moveDocumentBlock(current, {
      documentSignature: getDocumentBlockSignature(original),
      source: { kind: "topLevel", path: [0] },
      target: { kind: "topLevel", path: [1], placement: "after" },
    });

    expect(result).toEqual({ changed: false, reason: "stale" });
  });

  it("moves top-level blocks down with the destination adjusted after removal", () => {
    const document = paragraphDocument("A", "B", "C");

    const result = moveDocumentBlock(document, {
      source: { kind: "topLevel", path: [0] },
      target: { direction: "down", kind: "relative" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "topLevel", path: [1] } });
    expect(result.changed && paragraphTexts(result.contentJson)).toEqual(["B", "A", "C"]);
  });

  it("moves list items down without mutating the input", () => {
    const document = listDocument(["A", "B", "C"], ["D"]);
    const snapshot = structuredClone(document);

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0] },
      target: { direction: "down", kind: "relative" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 1] } });
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["B", "A", "C"]);
    expect(document).toEqual(snapshot);
    expect(result.changed && result.contentJson).not.toBe(document);
  });

  it("outdents a nested item through the same relative intent", () => {
    const document = nestedListDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0, 0, 1] },
      target: { direction: "outdent", kind: "relative" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 1] } });
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["Parent", "Nested B"]);
    expect(result.changed && listTextsAtPath(result.contentJson, [0, 0])).toEqual(["Nested A"]);
  });

  it("indents through the same seam and rejects a stale drag before mutation", () => {
    const document = listDocument(["A", "B"], ["C"]);
    const stale = moveDocumentBlock(document, {
      documentSignature: getDocumentBlockSignature(listDocument(["A changed", "B"], ["C"])),
      source: { kind: "listItem", path: [0, 1] },
      target: { direction: "indent", kind: "relative" },
    });
    expect(stale).toEqual({ changed: false, reason: "stale" });

    const result = moveDocumentBlock(document, {
      documentSignature: getDocumentBlockSignature(document),
      source: { kind: "listItem", path: [0, 1] },
      target: { direction: "indent", kind: "relative" },
    });
    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 0, 0, 0] } });
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["A"]);
    expect(result.changed && listTextsAtPath(result.contentJson, [0, 0])).toEqual(["B"]);
  });

  it("returns the appended same-type nested list destination when indent cannot reuse the terminal list", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              attrs: { checked: false },
              type: "taskItem",
              content: [
                paragraph("Previous task"),
                { type: "bulletList", content: listItems(["Existing bullet child"]) },
              ],
            },
            { attrs: { checked: true }, type: "taskItem", content: [paragraph("Checked task")] },
          ],
        },
      ],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 1] },
      target: { direction: "indent", kind: "relative" },
    });

    expect(result).toMatchObject({
      changed: true,
      destination: { kind: "listItem", path: [0, 0, 1, 0] },
    });
    const nestedLists = result.changed ? nestedListsForFirstItem(result.contentJson) : [];
    expect(nestedLists.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    expect(nestedLists[1]?.content?.[0]).toMatchObject({ attrs: { checked: true }, type: "taskItem" });
  });

  it("moves a nested item between parents and resolves the adjusted path", () => {
    const document = twoParentNestedListDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0, 0, 1] },
      target: { kind: "listItem", path: [0, 1, 0, 0], placement: "before" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 1, 0, 0] } });
    expect(result.changed && listTextsAtPath(result.contentJson, [0, 0])).toEqual(["A child"]);
    expect(result.changed && listTextsAtPath(result.contentJson, [0, 1])).toEqual(["B child 2", "B child"]);
  });

  it("moves an item inside the second nested list and returns its unambiguous destination", () => {
    const document = multipleNestedListsDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0, 1, 0] },
      target: { direction: "down", kind: "relative" },
    });

    expect(result).toMatchObject({
      changed: true,
      destination: { kind: "listItem", path: [0, 0, 1, 1] },
    });
    expect(result.changed && nestedListTextsByOrdinal(result.contentJson, 0)).toEqual(["Bullet A", "Bullet B"]);
    expect(result.changed && nestedListTextsByOrdinal(result.contentJson, 1)).toEqual(["Ordered B", "Ordered A"]);
  });

  it("honors the second nested list as a slot target", () => {
    const document = multipleNestedListsDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 1] },
      target: { index: 1, kind: "listItemSlot", listPath: [0, 0, 1] },
    });

    expect(result).toMatchObject({
      changed: true,
      destination: { kind: "listItem", path: [0, 0, 1, 1] },
    });
    expect(result.changed && nestedListTextsByOrdinal(result.contentJson, 0)).toEqual(["Bullet A", "Bullet B"]);
    expect(result.changed && nestedListTextsByOrdinal(result.contentJson, 1)).toEqual([
      "Ordered A",
      "Root source",
      "Ordered B",
    ]);
  });

  it("adjusts the destination ordinal when moving a sole item deletes its sibling source list", () => {
    const document = siblingNestedListsWithSoleSourceDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0, 0, 0] },
      target: { index: 1, kind: "listItemSlot", listPath: [0, 0, 1] },
    });

    expect(result).toMatchObject({
      changed: true,
      destination: { kind: "listItem", path: [0, 0, 0, 1] },
    });
    const nestedLists = result.changed ? nestedListsForFirstItem(result.contentJson) : [];
    expect(nestedLists.map((node) => node.type)).toEqual(["orderedList"]);
    expect(result.changed && nestedListTextsByOrdinal(result.contentJson, 0)).toEqual(["Target first", "Source only"]);
  });

  it("rejects moving a parent into its own descendant", () => {
    const document = nestedListDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0] },
      target: { kind: "listItem", path: [0, 0, 0, 0], placement: "after" },
    });

    expect(result).toEqual({ changed: false, reason: "invalid" });
  });

  it("rejects moving a parent into its second nested list descendant", () => {
    const document = multipleNestedListsDocument();

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0] },
      target: { index: 1, kind: "listItemSlot", listPath: [0, 0, 1] },
    });

    expect(result).toEqual({ changed: false, reason: "invalid" });
  });

  it("classifies malformed and type-mismatched paths as invalid", () => {
    const document = paragraphDocument("A", "B");

    expect(
      moveDocumentBlock(document, {
        source: { kind: "listItem", path: [0, 0] },
        target: { direction: "down", kind: "relative" },
      }),
    ).toEqual({ changed: false, reason: "invalid" });
    expect(
      moveDocumentBlock(document, {
        source: { kind: "topLevel", path: [-1] },
        target: { kind: "topLevel", path: [1], placement: "after" },
      }),
    ).toEqual({ changed: false, reason: "invalid" });
  });

  it("converts a top-level paragraph to a list item and returns its full destination path", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [paragraph("Loose"), list("A", "B")],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "topLevel", path: [0] },
      target: { kind: "listItem", path: [1, 0], placement: "after" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 1] } });
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["A", "Loose", "B"]);
  });

  it("moves a list item to a top-level list and returns the nested destination", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [paragraph("Anchor"), list("A", "B")],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [1, 1] },
      target: { kind: "topLevel", path: [0], placement: "before" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 0] } });
    expect(result.changed && topLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["B"]);
  });

  it("keeps a top-level block between list items by splitting the target list", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [paragraph("Loose"), list("A", "B", "C")],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "topLevel", path: [0] },
      target: { destinationKind: "topLevel", kind: "listItem", path: [1, 1], placement: "after" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "topLevel", path: [1] } });
    expect(result.changed && topLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["A", "B"]);
    expect(result.changed && directListTexts(result.contentJson, 2)).toEqual(["C"]);
  });

  it("accepts normalized list slots used by drag callers", () => {
    const document = listDocument(["A"], ["C", "D"]);

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 0] },
      target: { index: 1, kind: "listItemSlot", listPath: [1] },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [0, 1] } });
    expect(result.changed && directListTexts(result.contentJson, 0)).toEqual(["C", "A", "D"]);
  });

  it("resolves a new top-level list after a non-empty source list without subtracting its index", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [list("A", "B"), paragraph("Anchor")],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "listItem", path: [0, 1] },
      target: { kind: "topLevel", path: [1], placement: "after" },
    });

    expect(result).toMatchObject({ changed: true, destination: { kind: "listItem", path: [2, 0] } });
    expect(result.changed && topLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(result.changed && directListTexts(result.contentJson, 2)).toEqual(["B"]);
  });

  it("rejects nested split-list targets that the low-level transform cannot represent", () => {
    const document: TiptapJson = {
      type: "doc",
      content: [paragraph("Loose"), nestedListDocument().content![0]],
    };

    const result = moveDocumentBlock(document, {
      source: { kind: "topLevel", path: [0] },
      target: {
        destinationKind: "topLevel",
        kind: "listItem",
        path: [1, 0, 0, 0],
        placement: "after",
      },
    });

    expect(result).toEqual({ changed: false, reason: "invalid" });
  });

  it("classifies valid boundary moves and a sole-list extraction beside itself as same-slot", () => {
    const paragraphs = paragraphDocument("A", "B");
    expect(moveDocumentBlock(paragraphs, {
      source: { kind: "topLevel", path: [0] },
      target: { direction: "up", kind: "relative" },
    })).toEqual({ changed: false, reason: "same_slot" });
    expect(moveDocumentBlock(paragraphs, {
      source: { kind: "topLevel", path: [1] },
      target: { direction: "down", kind: "relative" },
    })).toEqual({ changed: false, reason: "same_slot" });

    const items = listDocument(["A", "B"], ["C"]);
    expect(moveDocumentBlock(items, {
      source: { kind: "listItem", path: [0, 0] },
      target: { direction: "up", kind: "relative" },
    })).toEqual({ changed: false, reason: "same_slot" });
    expect(moveDocumentBlock(items, {
      source: { kind: "listItem", path: [0, 1] },
      target: { direction: "down", kind: "relative" },
    })).toEqual({ changed: false, reason: "same_slot" });

    const soleList: TiptapJson = { type: "doc", content: [list("Only"), paragraph("Anchor")] };
    for (const placement of ["before", "after"] as const) {
      expect(moveDocumentBlock(soleList, {
        source: { kind: "listItem", path: [0, 0] },
        target: { kind: "topLevel", path: [0], placement },
      })).toEqual({ changed: false, reason: "same_slot" });
    }
  });

  it("normalizes editor range and drop descriptors inside the deep module", () => {
    expect(createDocumentBlockLocation({
      kind: "listItem",
      listItemPath: [1, 2, 3],
      topLevelIndex: 3,
    })).toEqual({ kind: "listItem", path: [3, 1, 2, 3] });
    expect(createDocumentBlockMoveTarget({
      action: "indent",
      dropIndex: 0,
      kind: "listLevel",
    })).toEqual({ direction: "indent", kind: "relative" });
    expect(createDocumentBlockMoveTarget({
      dropIndex: 2,
      kind: "listItem",
      listItemPath: [1, 0],
      topLevelIndex: 4,
    })).toEqual({ index: 2, kind: "listItemSlot", listPath: [4, 1, 0] });
  });

  it("keeps operation selection and destination calculation out of DocumentEditor", async () => {
    const editorSource = await readFile(
      resolve(process.cwd(), "src/components/document/DocumentEditor.tsx"),
      "utf8",
    );

    expect(editorSource).toContain("moveDocumentBlock(currentContent");
    expect(editorSource).toContain("focusMovedBlock(editor, result.destination)");
    expect(editorSource).not.toMatch(/move(?:ListItem|TopLevelBlock).*InTiptapJson/);
    expect(editorSource).not.toContain("getMovedListItemPath");
    expect(editorSource).not.toContain("function toDocumentBlockLocation");
    expect(editorSource).not.toContain("function toDocumentBlockMoveTarget");
    expect(editorSource).not.toContain('dropTarget.action === "indent"');
  });
});

function paragraphDocument(...texts: string[]): TiptapJson {
  return {
    type: "doc",
    content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}

function listDocument(first: string[], second: string[]): TiptapJson {
  return {
    type: "doc",
    content: [
      { type: "bulletList", content: listItems(first) },
      { type: "bulletList", content: listItems(second) },
    ],
  };
}

function listItems(texts: string[]) {
  return texts.map((text) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  }));
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function list(...texts: string[]) {
  return { type: "bulletList", content: listItems(texts) };
}

function nestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [paragraph("Parent"), list("Nested A", "Nested B")],
          },
        ],
      },
    ],
  };
}

function twoParentNestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph("Parent A"), list("A child", "B child 2")] },
          { type: "listItem", content: [paragraph("Parent B"), list("B child")] },
        ],
      },
    ],
  };
}

function multipleNestedListsDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("Parent"),
              { type: "bulletList", content: listItems(["Bullet A", "Bullet B"]) },
              { attrs: { start: 4 }, type: "orderedList", content: listItems(["Ordered A", "Ordered B"]) },
            ],
          },
          { type: "listItem", content: [paragraph("Root source")] },
        ],
      },
    ],
  };
}

function siblingNestedListsWithSoleSourceDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("Parent"),
              { type: "bulletList", content: listItems(["Source only"]) },
              { attrs: { start: 4 }, type: "orderedList", content: listItems(["Target first"]) },
            ],
          },
        ],
      },
    ],
  };
}

function nestedListTextsByOrdinal(document: TiptapJson, ordinal: number) {
  const topLevelList = document.content?.[0] as TiptapJson | undefined;
  const parentItem = topLevelList?.content?.[0] as TiptapJson | undefined;
  const nestedLists = (parentItem?.content ?? []).filter((node) => {
    const type = (node as { type?: string }).type;
    return type === "bulletList" || type === "orderedList" || type === "taskList";
  }) as TiptapJson[];
  return (nestedLists[ordinal]?.content ?? []).map((item) => readFirstText(item as TiptapJson));
}

function nestedListsForFirstItem(document: TiptapJson) {
  const topLevelList = document.content?.[0] as TiptapJson | undefined;
  const parentItem = topLevelList?.content?.[0] as TiptapJson | undefined;
  return (parentItem?.content ?? []).filter((node) => {
    const type = (node as { type?: string }).type;
    return type === "bulletList" || type === "orderedList" || type === "taskList";
  }) as TiptapJson[];
}

function paragraphTexts(document: TiptapJson) {
  return (document.content ?? []).map((node) => readFirstText(node as TiptapJson));
}

function topLevelTypes(document: TiptapJson) {
  return (document.content ?? []).map((node) => (node as TiptapJson).type);
}

function directListTexts(document: TiptapJson, topLevelIndex: number) {
  const listNode = document.content?.[topLevelIndex] as TiptapJson | undefined;
  return (listNode?.content ?? []).map((node) => readFirstText(node as TiptapJson));
}

function listTextsAtPath(document: TiptapJson, parentPath: number[]) {
  let listNode = document.content?.[parentPath[0]!] as TiptapJson | undefined;
  for (const itemIndex of parentPath.slice(1)) {
    const item = listNode?.content?.[itemIndex] as TiptapJson | undefined;
    listNode = item?.content?.find((node) => ["bulletList", "orderedList", "taskList"].includes((node as TiptapJson).type ?? "")) as
      | TiptapJson
      | undefined;
  }
  return (listNode?.content ?? []).map((node) => readFirstText(node as TiptapJson));
}

function readFirstText(node: { content?: unknown[]; text?: unknown; type?: string }): string {
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  for (const child of node.content ?? []) {
    const text = readFirstText(child as { content?: unknown[]; text?: unknown; type?: string });
    if (text) return text;
  }
  return "";
}
