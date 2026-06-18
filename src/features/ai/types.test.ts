import { describe, expect, it } from "vitest";
import { aiCommandPayloadSchema } from "./types";

const basePayload = {
  command: "Review",
  documentId: "doc_1",
  templateId: "template_1",
};

describe("aiCommandPayloadSchema", () => {
  it("rejects oversized command text before provider orchestration starts", () => {
    const result = aiCommandPayloadSchema.safeParse({
      ...basePayload,
      command: "x".repeat(4_001),
    });

    expect(result.success).toBe(false);
  });

  it("limits referenced documents so one request cannot hydrate an unbounded library", () => {
    const result = aiCommandPayloadSchema.safeParse({
      ...basePayload,
      references: {
        documents: Array.from({ length: 9 }, (_, index) => ({
          documentId: `doc_${index}`,
        })),
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a command default apply mode from the editor command metadata", () => {
    const result = aiCommandPayloadSchema.safeParse({
      ...basePayload,
      defaultApplyMode: "insert_below",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaultApplyMode).toBe("insert_below");
  });

  it("accepts large unsaved draft text so provider truncation can handle it consistently", () => {
    const result = aiCommandPayloadSchema.safeParse({
      ...basePayload,
      documentText: "Large draft ".repeat(60_000),
    });

    expect(result.success).toBe(true);
  });
});
