import { describe, expect, it } from "vitest";
import { applyProposalToText, validateProposalTargetOccurrence } from "./proposal-apply";

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

  it("returns an empty target failure for blank target text", () => {
    const result = applyProposalToText("A weak claim.", "", "A better claim.");

    expect(result).toEqual({
      ok: false,
      reason: "empty_target",
    });
  });

  it("returns an ambiguous target failure when target text appears more than once", () => {
    const result = applyProposalToText("Repeat this. Repeat this.", "Repeat this.", "Replace this.");

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_target",
    });
  });
});

describe("validateProposalTargetOccurrence", () => {
  it("allows a repeated target when a matching occurrence index is provided", () => {
    const result = validateProposalTargetOccurrence("Repeat this. Repeat this.", "Repeat this.", 1);

    expect(result).toEqual({ ok: true });
  });

  it("rejects an occurrence index outside the target matches", () => {
    const result = validateProposalTargetOccurrence("Repeat this once.", "Repeat this", 1);

    expect(result).toEqual({ ok: false, reason: "target_not_found" });
  });
});
