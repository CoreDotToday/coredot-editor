import { describe, expect, it } from "vitest";
import {
  createEditorBlockDragSession,
  isEditorBlockDragSessionStale,
} from "./editor-block-drag-session";

describe("editor block drag session", () => {
  it("detects stale drag sessions from document JSON signatures", () => {
    const source = {
      from: 1,
      kind: "topLevel" as const,
      node: { textContent: "Original block text" },
      to: 2,
      topLevelIndex: 0,
    };
    const session = createEditorBlockDragSession(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original block text" }] }] },
      source as never,
    );

    expect(
      isEditorBlockDragSessionStale(session, {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Original block text" }] }],
      }),
    ).toBe(false);
    expect(
      isEditorBlockDragSessionStale(session, {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Changed block text" }] }],
      }),
    ).toBe(true);
  });
});
