import { describe, expect, it } from "vitest";
import {
  applyProposalToTiptapDraft,
  createProposalApplyOptions,
  createProposalContentSignature,
  getProposalApplicationOrder,
  getProposalSelectionRange,
  isProposalSnapshotStale,
} from "./proposal-transaction";

const documentWithTarget = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
    { type: "paragraph", content: [{ type: "text", text: "Existing follow-up" }] },
  ],
};

const staleSelectionDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Edited text" }] },
    { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
  ],
};

const repeatedTargetDocument = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Repeat target." }] },
    { type: "paragraph", content: [{ type: "text", text: "Repeat target." }] },
  ],
};

describe("getProposalSelectionRange", () => {
  it("prefers a persisted proposal range over the current session context range", () => {
    const range = getProposalSelectionRange(
      { targetFrom: 10, targetTo: 22 },
      { selectionRange: { from: 1, to: 8 } },
    );

    expect(range).toEqual({ from: 10, to: 22 });
  });
});

describe("proposal operation snapshots", () => {
  it("detects stale proposal snapshots from content signatures", () => {
    const contentSignature = createProposalContentSignature(documentWithTarget);

    expect(isProposalSnapshotStale({ contentSignature }, documentWithTarget)).toBe(false);
    expect(isProposalSnapshotStale({ contentSignature }, staleSelectionDocument)).toBe(true);
    expect(isProposalSnapshotStale(undefined, staleSelectionDocument)).toBe(false);
  });
});

describe("createProposalApplyOptions", () => {
  it("requires range matches for range-backed proposals", () => {
    const options = createProposalApplyOptions(undefined, { from: 1, to: 12 }, "review");

    expect(options).toEqual({
      requireSelectionRangeMatch: true,
      selectionRange: { from: 1, to: 12 },
    });
  });
});

describe("getProposalApplicationOrder", () => {
  it("orders range-backed proposals from later document positions to earlier positions", () => {
    const orderedProposals = getProposalApplicationOrder(
      [
        { id: "early", targetFrom: 1, targetTo: 6 },
        { id: "plain" },
        { id: "late", targetFrom: 18, targetTo: 24 },
        { id: "middle" },
      ],
      {
        middle: { selectionRange: { from: 8, to: 14 } },
      },
    );

    expect(orderedProposals.map((proposal) => proposal.id)).toEqual(["late", "middle", "early", "plain"]);
  });
});

describe("applyProposalToTiptapDraft", () => {
  it("applies insert_below proposals through Tiptap insertion and returns changed content", () => {
    const result = applyProposalToTiptapDraft(documentWithTarget, {
      id: "proposal_insert",
      targetText: "Target text",
      replacementText: "Inserted recommendation",
      defaultApplyMode: "insert_below",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.contentJson.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
      { type: "paragraph", content: [{ type: "text", text: "Inserted recommendation" }] },
      { type: "paragraph", content: [{ type: "text", text: "Existing follow-up" }] },
    ]);
  });

  it("returns a stale selection failure without mutating content when the stored range no longer matches", () => {
    const originalContent = structuredClone(staleSelectionDocument);
    const result = applyProposalToTiptapDraft(staleSelectionDocument, {
      id: "proposal_stale",
      targetText: "Target text",
      replacementText: "Replacement text",
      source: "selection",
      targetFrom: 1,
      targetTo: 12,
    });

    expect(result).toEqual({ ok: false, reason: "stale_selection" });
    expect(staleSelectionDocument).toEqual(originalContent);
  });

  it("applies repeated target proposals to the requested occurrence", () => {
    const result = applyProposalToTiptapDraft(repeatedTargetDocument, {
      id: "proposal_repeat",
      occurrenceIndex: 1,
      targetText: "Repeat target.",
      replacementText: "Second target only.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.contentJson.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Repeat target." }] },
      { type: "paragraph", content: [{ type: "text", text: "Second target only." }] },
    ]);
  });
});
