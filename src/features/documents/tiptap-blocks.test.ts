import { describe, expect, it } from "vitest";
import type { TiptapJson } from "@/db/schema";
import {
  convertListItemToTopLevelParagraphInTiptapJson,
  indentListItemInTiptapJson,
  moveListItemInTiptapJson,
  moveListItemToTopLevelInTiptapJson,
  moveTopLevelBlockBetweenListItemsInTiptapJson,
  moveTopLevelBlockInTiptapJson,
  moveTopLevelBlockToListItemInTiptapJson,
} from "./tiptap-blocks";

describe("indentListItemInTiptapJson", () => {
  it("appends a task sublist after a terminal bullet sublist and preserves checked state", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              attrs: { checked: false },
              type: "taskItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Previous task" }] },
                { type: "bulletList", content: createListItems(["Existing bullet child"]) },
              ],
            },
            {
              attrs: { checked: true },
              type: "taskItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Checked task" }] }],
            },
          ],
        },
      ],
    };

    const result = indentListItemInTiptapJson(contentJson, { listIndex: 0, sourceIndex: 1 });

    expect(result.changed).toBe(true);
    const previousContent = readFirstListItemContent(result.contentJson);
    expect(previousContent.map((node) => node.type)).toEqual(["paragraph", "bulletList", "taskList"]);
    expect(readListTexts(previousContent[1])).toEqual(["Existing bullet child"]);
    expect(previousContent[2]).toMatchObject({
      type: "taskList",
      content: [
        {
          attrs: { checked: true },
          type: "taskItem",
        },
      ],
    });
  });

  it("appends a source-typed ordered sublist instead of reusing a non-terminal one or a terminal bullet list", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          attrs: { start: 7 },
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Previous ordered" }] },
                { attrs: { start: 3 }, type: "orderedList", content: createListItems(["Existing ordered child"]) },
                { type: "bulletList", content: createListItems(["Terminal bullet child"]) },
              ],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Seventh item" }] }],
            },
          ],
        },
      ],
    };

    const result = indentListItemInTiptapJson(contentJson, { listIndex: 0, sourceIndex: 1 });

    expect(result.changed).toBe(true);
    const previousContent = readFirstListItemContent(result.contentJson);
    expect(previousContent.map((node) => node.type)).toEqual([
      "paragraph",
      "orderedList",
      "bulletList",
      "orderedList",
    ]);
    expect(readListTexts(previousContent[1])).toEqual(["Existing ordered child"]);
    expect(readListTexts(previousContent[2])).toEqual(["Terminal bullet child"]);
    expect(previousContent[3]).toMatchObject({
      attrs: { start: 7 },
      type: "orderedList",
    });
    expect(readListTexts(previousContent[3])).toEqual(["Seventh item"]);
  });
});

describe("moveTopLevelBlockInTiptapJson", () => {
  it("moves a top-level block to the requested drop index", () => {
    const contentJson = createDocument(["First", "Second", "Third"]);

    const result = moveTopLevelBlockInTiptapJson(contentJson, 0, 2);

    expect(result.changed).toBe(true);
    expect(readDocumentParagraphs(result.contentJson)).toEqual(["Second", "First", "Third"]);
  });

  it("keeps the document unchanged when the drop is inside the same block slot", () => {
    const contentJson = createDocument(["First", "Second"]);

    const result = moveTopLevelBlockInTiptapJson(contentJson, 0, 1);

    expect(result.changed).toBe(false);
    expect(readDocumentParagraphs(result.contentJson)).toEqual(["First", "Second"]);
  });
});

describe("moveListItemInTiptapJson", () => {
  it("moves a list item inside the same top-level list", () => {
    const contentJson = createListDocument(["First", "Second", "Third"]);

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 3,
      listIndex: 0,
      sourceIndex: 0,
    });

    expect(result.changed).toBe(true);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Second", "Third", "First"]);
  });

  it("keeps the document unchanged when the list item drop is in the same slot", () => {
    const contentJson = createListDocument(["First", "Second"]);

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 0,
      sourceIndex: 0,
    });

    expect(result.changed).toBe(false);
    expect(readDocumentListItems(result.contentJson)).toEqual(["First", "Second"]);
  });

  it("moves a nested list item inside the same nested list", () => {
    const contentJson = createNestedListDocument();

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 3,
      listIndex: 0,
      sourceIndex: 0,
      sourceParentPath: [0],
      targetParentPath: [0],
    });

    expect(result.changed).toBe(true);
    expect(readNestedListItems(result.contentJson)).toEqual(["Nested second", "Nested third", "Nested first"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Parent"]);
  });

  it("moves a sole item into a sibling nested list after the source list ordinal collapses", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
                { type: "bulletList", content: createListItems(["Source only"]) },
                { attrs: { start: 4 }, type: "orderedList", content: createListItems(["Target first"]) },
              ],
            },
          ],
        },
      ],
    };

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 0,
      sourceIndex: 0,
      sourceListPath: [0, 0],
      targetListPath: [0, 1],
    });

    expect(result.changed).toBe(true);
    const parentContent = readFirstListItemContent(result.contentJson);
    expect(parentContent.map((node) => node.type)).toEqual(["paragraph", "orderedList"]);
    expect(readListTexts(parentContent[1])).toEqual(["Target first", "Source only"]);
  });

  it("moves a nested list item into an ancestor list parent", () => {
    const contentJson = createNestedListDocument();

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 0,
      listIndex: 0,
      sourceIndex: 0,
      sourceParentPath: [0],
      targetParentPath: [],
    });

    expect(result.changed).toBe(true);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Nested first", "Parent"]);
    expect(readNestedListItems(result.contentJson)).toEqual(["Nested second", "Nested third"]);
  });

  it("moves a deeply nested list item into its ancestor list parent", () => {
    const contentJson = createDeeplyNestedListDocument();

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 3,
      listIndex: 0,
      sourceIndex: 0,
      sourceParentPath: [0, 0],
      targetParentPath: [0],
    });

    expect(result.changed).toBe(true);
    expect(readListItemsAtPath(result.contentJson, [0])).toEqual(["3", "2", "5", "4"]);
    expect(readListItemsAtPath(result.contentJson, [0, 0])).toEqual([]);
  });

  it("moves an ordered list item into a separate bullet list", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: createListItems(["First ordered", "Second ordered"]),
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Divider paragraph" }],
        },
        {
          type: "bulletList",
          content: createListItems(["First bullet", "Second bullet"]),
        },
      ],
    };

    const result = moveListItemInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 0,
      sourceIndex: 1,
      targetListIndex: 2,
      targetParentPath: [],
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["orderedList", "paragraph", "bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual([
      "First ordered",
      "First bullet",
      "Second ordered",
      "Second bullet",
    ]);
  });
});

describe("moveListItemToTopLevelInTiptapJson", () => {
  it("splits a list item into its own top-level list at the requested drop index", () => {
    const contentJson = createDocumentWithParagraphAndList("Anchor", ["First", "Second"]);

    const result = moveListItemToTopLevelInTiptapJson(contentJson, {
      dropIndex: 0,
      listIndex: 1,
      sourceIndex: 1,
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Second", "First"]);
  });

  it("keeps a single-item list unchanged when dropped into the same top-level slot", () => {
    const contentJson = createListDocument(["Only"]);

    const result = moveListItemToTopLevelInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 0,
      sourceIndex: 0,
    });

    expect(result.changed).toBe(false);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Only"]);
  });

  it("moves a nested list item out to its own top-level list", () => {
    const contentJson = createNestedListDocument();

    const result = moveListItemToTopLevelInTiptapJson(contentJson, {
      dropIndex: 0,
      listIndex: 0,
      sourceIndex: 0,
      sourceParentPath: [0],
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList", "bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Nested first", "Parent"]);
    expect(readNestedListItems(result.contentJson)).toEqual(["Nested second", "Nested third"]);
  });

  it("preserves a nested ordered list type when moving an item out to top level", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Parent" }],
                },
                {
                  type: "orderedList",
                  content: createListItems(["Nested ordered first", "Nested ordered second"]),
                },
              ],
            },
          ],
        },
      ],
    };

    const result = moveListItemToTopLevelInTiptapJson(contentJson, {
      dropIndex: 0,
      listIndex: 0,
      sourceIndex: 0,
      sourceParentPath: [0],
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["orderedList", "bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Nested ordered first", "Parent"]);
  });
});

describe("moveTopLevelBlockToListItemInTiptapJson", () => {
  it("converts a top-level paragraph into a list item at the requested list position", () => {
    const contentJson = createDocumentWithParagraphAndList("Loose paragraph", ["First", "Second"]);

    const result = moveTopLevelBlockToListItemInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 1,
      sourceIndex: 0,
      targetParentPath: [],
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["First", "Loose paragraph", "Second"]);
  });

  it("moves a top-level paragraph into a nested list parent", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Loose paragraph" }],
        },
        ...createNestedListDocument().content!,
      ],
    };

    const result = moveTopLevelBlockToListItemInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 1,
      sourceIndex: 0,
      targetParentPath: [0],
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList"]);
    expect(readDocumentListItems(result.contentJson)).toEqual(["Parent"]);
    expect(readNestedListItems(result.contentJson)).toEqual([
      "Nested first",
      "Loose paragraph",
      "Nested second",
      "Nested third",
    ]);
  });
});

describe("moveTopLevelBlockBetweenListItemsInTiptapJson", () => {
  it("keeps a dragged paragraph as a top-level block by splitting a bullet list", () => {
    const contentJson = createDocumentWithParagraphAndList("Loose paragraph", ["First", "Second"]);

    const result = moveTopLevelBlockBetweenListItemsInTiptapJson(contentJson, {
      dropIndex: 1,
      listIndex: 1,
      sourceIndex: 0,
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(readTopLevelParagraphs(result.contentJson)).toEqual(["Loose paragraph"]);
    expect(readTopLevelListItemsByList(result.contentJson)).toEqual([["First"], ["Second"]]);
  });

  it("continues ordered list numbering after the inserted top-level block", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Loose ordered paragraph" }],
        },
        {
          attrs: { start: 3 },
          type: "orderedList",
          content: createListItems(["Third", "Fourth", "Fifth"]),
        },
      ],
    };

    const result = moveTopLevelBlockBetweenListItemsInTiptapJson(contentJson, {
      dropIndex: 2,
      listIndex: 1,
      sourceIndex: 0,
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["orderedList", "paragraph", "orderedList"]);
    expect(readTopLevelParagraphs(result.contentJson)).toEqual(["Loose ordered paragraph"]);
    expect(readTopLevelListItemsByList(result.contentJson)).toEqual([["Third", "Fourth"], ["Fifth"]]);
    expect((result.contentJson.content?.[2] as { attrs?: { start?: number } }).attrs?.start).toBe(5);
  });
});

describe("convertListItemToTopLevelParagraphInTiptapJson", () => {
  it("turns a middle bullet list item into a top-level paragraph by splitting the list", () => {
    const contentJson = createListDocument(["First", "Second", "Third"]);

    const result = convertListItemToTopLevelParagraphInTiptapJson(contentJson, {
      listIndex: 0,
      sourceIndex: 1,
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["bulletList", "paragraph", "bulletList"]);
    expect(readTopLevelParagraphs(result.contentJson)).toEqual(["Second"]);
    expect(readTopLevelListItemsByList(result.contentJson)).toEqual([["First"], ["Third"]]);
  });

  it("continues ordered list numbering after converting an item to text", () => {
    const contentJson: TiptapJson = {
      type: "doc",
      content: [
        {
          attrs: { start: 4 },
          type: "orderedList",
          content: createListItems(["Fourth", "Fifth", "Sixth"]),
        },
      ],
    };

    const result = convertListItemToTopLevelParagraphInTiptapJson(contentJson, {
      listIndex: 0,
      sourceIndex: 1,
    });

    expect(result.changed).toBe(true);
    expect(readTopLevelTypes(result.contentJson)).toEqual(["orderedList", "paragraph", "orderedList"]);
    expect(readTopLevelParagraphs(result.contentJson)).toEqual(["Fifth"]);
    expect(readTopLevelListItemsByList(result.contentJson)).toEqual([["Fourth"], ["Sixth"]]);
    expect((result.contentJson.content?.[2] as { attrs?: { start?: number } }).attrs?.start).toBe(6);
  });
});

function createDocument(paragraphs: string[]): TiptapJson {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

function readFirstListItemContent(contentJson: TiptapJson) {
  const list = contentJson.content?.[0] as TiptapJson | undefined;
  const item = list?.content?.[0] as TiptapJson | undefined;
  return (item?.content ?? []) as TiptapJson[];
}

function readListTexts(listNode: TiptapJson | undefined) {
  return (listNode?.content ?? []).map((item) => readFirstParagraphText(item as { content?: unknown[] }));
}

function createDocumentWithParagraphAndList(paragraph: string, items: string[]): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: paragraph }],
      },
      {
        type: "bulletList",
        content: createListItems(items),
      },
    ],
  };
}

function createListDocument(items: string[]): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: createListItems(items),
      },
    ],
  };
}

function createListItems(items: string[]) {
  return items.map((text) => ({
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  }));
}

function createNestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Parent" }],
              },
              {
                type: "bulletList",
                content: ["Nested first", "Nested second", "Nested third"].map((text) => ({
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text }],
                    },
                  ],
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

function createDeeplyNestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "1" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "3" }] },
                      {
                        type: "bulletList",
                        content: createListItems(["4"]),
                      },
                    ],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "5" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function readDocumentParagraphs(contentJson: TiptapJson) {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  return content.map((node) => {
    const paragraph = node as { content?: Array<{ text?: string }> };
    return paragraph.content?.[0]?.text ?? "";
  });
}

function readDocumentListItems(contentJson: TiptapJson) {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  return content.flatMap((node) => {
    const list = node as { content?: Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }> };
    return (list.content ?? [])
      .filter((item) => Array.isArray(item.content))
      .map((item) => item.content?.[0]?.content?.[0]?.text ?? "");
  });
}

function readNestedListItems(contentJson: TiptapJson) {
  const parentItem = findListItemByText(contentJson, "Parent") as { content?: unknown[] } | null;
  const nestedList = parentItem?.content?.[1] as { content?: Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }> } | undefined;
  return (nestedList?.content ?? []).map((item) => item.content?.[0]?.content?.[0]?.text ?? "");
}

function readListItemsAtPath(contentJson: TiptapJson, parentPath: number[]) {
  let listNode = contentJson.content?.[0] as TiptapJson | undefined;

  for (const itemIndex of parentPath) {
    const listItem = listNode?.content?.[itemIndex] as TiptapJson | undefined;
    listNode = listItem?.content?.find((child) => {
      const type = (child as { type?: string }).type;
      return type === "bulletList" || type === "orderedList" || type === "taskList";
    }) as TiptapJson | undefined;
  }

  return ((listNode?.content ?? []) as Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }>).map(
    (item) => item.content?.[0]?.content?.[0]?.text ?? "",
  );
}

function readTopLevelTypes(contentJson: TiptapJson) {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  return content.map((node) => (node as { type?: string }).type);
}

function readTopLevelParagraphs(contentJson: TiptapJson) {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  return content
    .filter((node) => (node as { type?: string }).type === "paragraph")
    .map((node) => ((node as { content?: Array<{ text?: string }> }).content ?? []).map((child) => child.text ?? "").join(""));
}

function readTopLevelListItemsByList(contentJson: TiptapJson) {
  const content = Array.isArray(contentJson.content) ? contentJson.content : [];
  return content
    .filter((node) => {
      const type = (node as { type?: string }).type;
      return type === "bulletList" || type === "orderedList" || type === "taskList";
    })
    .map((node) => {
      const list = node as { content?: Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }> };
      return (list.content ?? [])
        .filter((item) => Array.isArray(item.content))
        .map((item) => item.content?.[0]?.content?.[0]?.text ?? "");
    });
}

function findListItemByText(node: unknown, text: string): unknown | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const typedNode = node as { content?: unknown[]; text?: string; type?: string };
  if (typedNode.type === "listItem" && readFirstParagraphText(typedNode) === text) {
    return typedNode;
  }

  for (const child of typedNode.content ?? []) {
    const result = findListItemByText(child, text);
    if (result) {
      return result;
    }
  }

  return null;
}

function readFirstParagraphText(node: { content?: unknown[] }) {
  const paragraph = node.content?.[0] as { content?: Array<{ text?: string }> } | undefined;
  return paragraph?.content?.[0]?.text ?? "";
}
