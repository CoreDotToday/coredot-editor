import { describe, expect, it } from "vitest";
import { normalizeDocumentMetadata, normalizeDocumentReadiness } from "./document-metadata";

describe("document metadata", () => {
  it("normalizes readiness values with a draft fallback", () => {
    expect(normalizeDocumentReadiness("ready")).toBe("ready");
    expect(normalizeDocumentReadiness("unknown")).toBe("draft");
  });

  it("keeps safe scalar metadata and trims tag lists", () => {
    expect(
      normalizeDocumentMetadata({
        owner: "  Legal  ",
        tags: [" contract ", "", "risk"],
        _internal: "ignored",
        nested: { invalid: true },
      }),
    ).toEqual({
      owner: "Legal",
      tags: ["contract", "risk"],
    });
  });
});
