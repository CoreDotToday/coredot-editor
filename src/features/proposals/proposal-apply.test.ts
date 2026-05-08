import { describe, expect, it } from "vitest";
import { applyProposalToText } from "./proposal-apply";

describe("applyProposalToText", () => {
  it("replaces target text once when it still matches the document", () => {
    const result = applyProposalToText("A weak claim. Next paragraph.", "A weak claim.", "A specific, evidence-backed claim.");

    expect(result).toEqual({
      ok: true,
      text: "A specific, evidence-backed claim. Next paragraph.",
    });
  });

  it("returns a mismatch when target text changed", () => {
    const result = applyProposalToText("A changed claim.", "A weak claim.", "A better claim.");

    expect(result).toEqual({
      ok: false,
      reason: "target_not_found",
    });
  });
});
