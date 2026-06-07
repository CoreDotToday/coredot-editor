import { describe, expect, it } from "vitest";
import { insertTextBelowTargetInTiptapJson, replaceTextInTiptapJson } from "./tiptap-replace";

const repeatedDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Revenue needs evidence." }] },
    { type: "paragraph", content: [{ type: "text", text: "Revenue needs evidence." }] },
  ],
};

const multiBlockDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "반갑습니다 안녕하세요." }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
        },
      ],
    },
  ],
};

const partialMultiBlockDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Intro stays. Replace starts here." }] },
    { type: "paragraph", content: [{ type: "text", text: "Finishes here. Outro stays." }] },
  ],
};

const staleSelectionDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Edited text" }] },
    { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
  ],
};

const bulletListDocument = {
  type: "doc" as const,
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
        },
      ],
    },
  ],
};

const mixedListParagraphDocument = {
  type: "doc" as const,
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "After list." }] },
  ],
};

const nestedListDocument = {
  type: "doc" as const,
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Parent item." }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Child item." }] }],
                },
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Sibling item." }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const orderedListDocument = {
  type: "doc" as const,
  content: [
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
        },
      ],
    },
  ],
};

const taskListDocument = {
  type: "doc" as const,
  content: [
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "First task." }] }],
        },
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Second task." }] }],
        },
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Third task." }] }],
        },
      ],
    },
  ],
};

const blockquoteDocument = {
  type: "doc" as const,
  content: [
    {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First quote." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second quote." }] },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "After quote." }] },
  ],
};

const codeBlockDocument = {
  type: "doc" as const,
  content: [
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a = 1;" }] },
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let b = 2;" }] },
  ],
};

describe("replaceTextInTiptapJson", () => {
  it("replaces a specific occurrence when the target text appears more than once", () => {
    const result = replaceTextInTiptapJson(repeatedDocument, "Revenue needs evidence.", "Revenue is backed by CRM data.", {
      occurrenceIndex: 1,
    });

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Revenue needs evidence." }] },
          { type: "paragraph", content: [{ type: "text", text: "Revenue is backed by CRM data." }] },
        ],
      },
    });
  });

  it("replaces a multi-block selection by its editor range", () => {
    const result = replaceTextInTiptapJson(
      multiBlockDocument,
      "반갑습니다 안녕하세요.\n본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
      "Nice to meet you Hello. This document confirms final consent.",
      { selectionRange: { from: 1, to: 80 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Nice to meet you Hello. This document confirms final consent." }],
          },
        ],
      },
    });
  });

  it("replaces a multi-block target by occurrence when no editor range is available", () => {
    const result = replaceTextInTiptapJson(
      multiBlockDocument,
      "반갑습니다 안녕하세요.\n본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
      "Nice to meet you Hello. This document confirms final consent.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Nice to meet you Hello. This document confirms final consent." }],
          },
        ],
      },
    });
  });

  it("replaces a partial multi-block target by occurrence when no editor range is available", () => {
    const result = replaceTextInTiptapJson(
      partialMultiBlockDocument,
      "Replace starts here.\nFinishes here.",
      "Combined replacement.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Intro stays. Combined replacement. Outro stays." }],
          },
        ],
      },
    });
  });

  it("rejects replacement when a required selection range no longer matches the target", () => {
    const result = replaceTextInTiptapJson(staleSelectionDocument, "Target text", "Replacement text", {
      occurrenceIndex: 0,
      requireSelectionRangeMatch: true,
      selectionRange: { from: 1, to: 12 },
    });

    expect(result).toEqual({ ok: false, reason: "stale_selection" });
  });

  it("replaces multiple selected list items by their editor range", () => {
    const result = replaceTextInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Combined replacement.",
      { selectionRange: { from: 3, to: 30 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Combined replacement." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces selected list items when the stored selection is clipped inside their text", () => {
    const result = replaceTextInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Combined replacement.",
      {
        requireSelectionRangeMatch: true,
        selectionRange: { from: 4, to: 29 },
      },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Combined replacement." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces a mixed list and paragraph selection by its editor range", () => {
    const result = replaceTextInTiptapJson(
      mixedListParagraphDocument,
      "First item.\nSecond item.\nAfter list.",
      "Combined list and paragraph replacement.",
      {
        requireSelectionRangeMatch: true,
        selectionRange: { from: 3, to: 45 },
      },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Combined list and paragraph replacement." }],
          },
        ],
      },
    });
  });

  it("replaces a selected nested list child by its editor range", () => {
    const result = replaceTextInTiptapJson(nestedListDocument, "Child item.", "Updated child item.", {
      requireSelectionRangeMatch: true,
      selectionRange: { from: 19, to: 30 },
    });

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Parent item." }] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Updated child item." }] }],
                      },
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Sibling item." }] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces multiple list items by occurrence when no editor range is available", () => {
    const result = replaceTextInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Combined replacement.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Combined replacement." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces multiple selected ordered-list items by their editor range", () => {
    const result = replaceTextInTiptapJson(
      orderedListDocument,
      "First item.\nSecond item.",
      "Combined replacement.",
      { selectionRange: { from: 3, to: 30 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "orderedList",
            attrs: { start: 1 },
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Combined replacement." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces multiple selected task-list items by their editor range", () => {
    const result = replaceTextInTiptapJson(
      taskListDocument,
      "First task.\nSecond task.",
      "Combined task replacement.",
      { selectionRange: { from: 3, to: 30 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Combined task replacement." }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third task." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("replaces a selected blockquote without breaking its nested paragraph structure", () => {
    const result = replaceTextInTiptapJson(
      blockquoteDocument,
      "First quote.\nSecond quote.",
      "Combined quote.",
      { selectionRange: { from: 2, to: 29 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Combined quote." }] }],
          },
          { type: "paragraph", content: [{ type: "text", text: "After quote." }] },
        ],
      },
    });
  });

  it("replaces selected code blocks by their editor range", () => {
    const result = replaceTextInTiptapJson(
      codeBlockDocument,
      "let a = 1;\nlet b = 2;",
      "const total = 3;",
      { selectionRange: { from: 1, to: 23 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const total = 3;" }] },
        ],
      },
    });
  });
});

describe("insertTextBelowTargetInTiptapJson", () => {
  it("inserts below the block containing a specific repeated occurrence", () => {
    const result = insertTextBelowTargetInTiptapJson(
      repeatedDocument,
      "Revenue needs evidence.",
      "매출에는 CRM 데이터 근거가 있습니다.",
      { occurrenceIndex: 1 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Revenue needs evidence." }] },
          { type: "paragraph", content: [{ type: "text", text: "Revenue needs evidence." }] },
          { type: "paragraph", content: [{ type: "text", text: "매출에는 CRM 데이터 근거가 있습니다." }] },
        ],
      },
    });
  });

  it("inserts below the last block of a multi-block selection range", () => {
    const result = insertTextBelowTargetInTiptapJson(
      multiBlockDocument,
      "반갑습니다 안녕하세요.\n본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
      "Nice to meet you Hello. This document confirms final consent.",
      { selectionRange: { from: 1, to: 80 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "반갑습니다 안녕하세요." }] },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
              },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Nice to meet you Hello. This document confirms final consent." }],
          },
        ],
      },
    });
  });

  it("inserts below a multi-block target by occurrence when no editor range is available", () => {
    const result = insertTextBelowTargetInTiptapJson(
      multiBlockDocument,
      "반갑습니다 안녕하세요.\n본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
      "Nice to meet you Hello. This document confirms final consent.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "반갑습니다 안녕하세요." }] },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "본 문서는 당사자 간 합의의 증거로서, 본 계약의 조건에 대해 양 당사자의 동의가 최종적으로 확인되었음을 명시합니다.",
              },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Nice to meet you Hello. This document confirms final consent." }],
          },
        ],
      },
    });
  });

  it("inserts below a partial multi-block target by occurrence when no editor range is available", () => {
    const result = insertTextBelowTargetInTiptapJson(
      partialMultiBlockDocument,
      "Replace starts here.\nFinishes here.",
      "Inserted after partial target.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Intro stays. Replace starts here." }] },
          { type: "paragraph", content: [{ type: "text", text: "Finishes here. Outro stays." }] },
          { type: "paragraph", content: [{ type: "text", text: "Inserted after partial target." }] },
        ],
      },
    });
  });

  it("rejects insertion when a required selection range no longer matches the target", () => {
    const result = insertTextBelowTargetInTiptapJson(staleSelectionDocument, "Target text", "Inserted text", {
      occurrenceIndex: 0,
      requireSelectionRangeMatch: true,
      selectionRange: { from: 1, to: 12 },
    });

    expect(result).toEqual({ ok: false, reason: "stale_selection" });
  });

  it("inserts below multiple selected list items by their editor range", () => {
    const result = insertTextBelowTargetInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Inserted suggestion.",
      { selectionRange: { from: 3, to: 30 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted suggestion." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts below selected list items when the stored selection is clipped inside their text", () => {
    const result = insertTextBelowTargetInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Inserted suggestion.",
      {
        requireSelectionRangeMatch: true,
        selectionRange: { from: 4, to: 29 },
      },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted suggestion." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts below a mixed list and paragraph selection by its editor range", () => {
    const result = insertTextBelowTargetInTiptapJson(
      mixedListParagraphDocument,
      "First item.\nSecond item.\nAfter list.",
      "Inserted after mixed selection.",
      {
        requireSelectionRangeMatch: true,
        selectionRange: { from: 3, to: 45 },
      },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          mixedListParagraphDocument.content[0],
          mixedListParagraphDocument.content[1],
          {
            type: "paragraph",
            content: [{ type: "text", text: "Inserted after mixed selection." }],
          },
        ],
      },
    });
  });

  it("inserts below a selected nested list child by its editor range", () => {
    const result = insertTextBelowTargetInTiptapJson(nestedListDocument, "Child item.", "Inserted child item.", {
      requireSelectionRangeMatch: true,
      selectionRange: { from: 19, to: 30 },
    });

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Parent item." }] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Child item." }] }],
                      },
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted child item." }] }],
                      },
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Sibling item." }] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts below multiple list items by occurrence when no editor range is available", () => {
    const result = insertTextBelowTargetInTiptapJson(
      bulletListDocument,
      "First item.\nSecond item.",
      "Inserted suggestion.",
      { occurrenceIndex: 0 },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted suggestion." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts a list item below a target that is found inside a bullet-list item", () => {
    const result = insertTextBelowTargetInTiptapJson(bulletListDocument, "Second item.", "Inserted suggestion.");

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted suggestion." }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts below multiple selected task-list items by their editor range", () => {
    const result = insertTextBelowTargetInTiptapJson(
      taskListDocument,
      "First task.\nSecond task.",
      "Inserted task suggestion.",
      { selectionRange: { from: 3, to: 30 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "First task." }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second task." }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted task suggestion." }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Third task." }] }],
              },
            ],
          },
        ],
      },
    });
  });

  it("inserts below a selected blockquote range", () => {
    const result = insertTextBelowTargetInTiptapJson(
      blockquoteDocument,
      "First quote.\nSecond quote.",
      "Inserted after quote.",
      { selectionRange: { from: 2, to: 29 } },
    );

    expect(result).toEqual({
      ok: true,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First quote." }] },
              { type: "paragraph", content: [{ type: "text", text: "Second quote." }] },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "Inserted after quote." }] },
          { type: "paragraph", content: [{ type: "text", text: "After quote." }] },
        ],
      },
    });
  });
});
