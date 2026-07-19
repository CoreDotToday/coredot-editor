import { createHash } from "node:crypto";

import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { COLLABORATION_BODY_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  applyCollaborativeProposalBatch,
  createCollaborativeProposalAnchor,
  findUniqueCollaborativeTextRange,
  type CollaborativeProposalAnchor,
} from "./proposal-command";

const profile = getProjectProfile("default");
const codec = createCollaborationDocumentCodec(profile);

describe("collaborative Proposal commands", () => {
  it("maps a unique reviewed target through the exact ProseMirror body", () => {
    const document = codec.bootstrap({
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "alpha" }] },
          { type: "paragraph", content: [{ type: "text", text: "beta target" }] },
        ],
      },
      metadataJson: {},
      plainText: "alpha\nbeta target",
      title: "Mapping",
    });

    const range = findUniqueCollaborativeTextRange(document, "beta target");

    expect(range).toEqual({ from: 8, to: 19 });
    expect(createCollaborativeProposalAnchor(document, {
      baseHeadSeq: 0,
      generation: 1,
      range: range!,
      schemaFingerprint: codec.fingerprint(),
    }).targetHash).toBe(sha256("beta target"));
  });

  it("fails closed when a reviewed target is absent or ambiguous", () => {
    const document = createDocument("target and target");

    expect(findUniqueCollaborativeTextRange(document, "missing")).toBeNull();
    expect(findUniqueCollaborativeTextRange(document, "target")).toBeNull();
    expect(findUniqueCollaborativeTextRange(document, "")).toBeNull();
  });

  it("stores canonical relative anchors and exact snapshot postconditions", () => {
    const document = createDocument("alpha beta gamma");
    const anchor = createCollaborativeProposalAnchor(document, {
      baseHeadSeq: 12,
      generation: 3,
      range: { from: 7, to: 11 },
      schemaFingerprint: codec.fingerprint(),
    });

    expect(anchor).toMatchObject({
      baseHeadSeq: 12,
      generation: 3,
      schemaFingerprint: codec.fingerprint(),
      startAssoc: -1,
      endAssoc: 1,
      targetHash: sha256("beta"),
      targetPreview: "beta",
    });
    expect(anchor.baseStateVector).toEqual(Y.encodeStateVector(document));
    expect(anchor.startRelative.byteLength).toBeGreaterThan(0);
    expect(anchor.endRelative.byteLength).toBeGreaterThan(0);
  });

  it("applies after an edit before the target and an unrelated head advance", () => {
    const document = createDocument("alpha beta gamma");
    const anchor = anchorFor(document, 7, 11);
    firstXmlText(document).insert(0, "preface ");

    const result = applyCollaborativeProposalBatch(document, identity(document, { headSeq: 9 }), [{
      anchor,
      mode: "replace",
      proposalId: "proposal_beta",
      replacementText: "BETTER",
    }]);

    expect(result).toMatchObject({ ok: true });
    expect(codec.materialize(document).plainText).toBe("preface alpha BETTER gamma");
  });

  it("inserts one exact paragraph immediately after the target's containing top-level block", () => {
    const document = codec.bootstrap({
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "alpha beta" }] },
          { type: "paragraph", content: [{ type: "text", text: "gamma" }] },
        ],
      },
      metadataJson: {},
      plainText: "alpha beta\ngamma",
      title: "Insert below",
    });
    const target = findUniqueCollaborativeTextRange(document, "beta")!;

    expect(applyCollaborativeProposalBatch(document, identity(document), [{
      anchor: anchorFor(document, target.from, target.to),
      mode: "insert_below",
      proposalId: "proposal_insert_below",
      replacementText: "INSERTED",
    }])).toMatchObject({ ok: true });

    expect(codec.materialize(document).contentJson.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "alpha beta" }] },
      { type: "paragraph", content: [{ type: "text", text: "INSERTED" }] },
      { type: "paragraph", content: [{ type: "text", text: "gamma" }] },
    ]);
  });

  it("rejects two non-overlapping targets that share one insert-below footprint", () => {
    const document = createDocument("alpha beta gamma");
    const before = Y.encodeStateAsUpdate(document);

    expect(applyCollaborativeProposalBatch(document, identity(document), [
      {
        anchor: anchorFor(document, 1, 6),
        mode: "insert_below",
        proposalId: "proposal_after_alpha",
        replacementText: "A",
      },
      {
        anchor: anchorFor(document, 7, 11),
        mode: "insert_below",
        proposalId: "proposal_after_beta",
        replacementText: "B",
      },
    ])).toEqual({ ok: false, reason: "proposal_overlap_conflict" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it.each([
    ["deleted target", (document: Y.Doc) => firstXmlText(document).delete(6, 4)],
    ["changed target", (document: Y.Doc) => firstXmlText(document).insert(8, "X")],
  ])("fails closed when the %s no longer matches", (_label, mutate) => {
    const document = createDocument("alpha beta gamma");
    const anchor = anchorFor(document, 7, 11);
    mutate(document);
    const before = Y.encodeStateAsUpdate(document);

    expect(applyCollaborativeProposalBatch(document, identity(document), [{
      anchor,
      mode: "replace",
      proposalId: "proposal_beta",
      replacementText: "BETTER",
    }])).toEqual({ ok: false, reason: "proposal_target_conflict" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it.each([
    ["generation", (anchor: CollaborativeProposalAnchor) => ({ ...anchor, generation: 2 })],
    ["schema", (anchor: CollaborativeProposalAnchor) => ({ ...anchor, schemaFingerprint: "f".repeat(64) })],
  ])("fails closed on a %s mismatch", (_label, alter) => {
    const document = createDocument("alpha beta gamma");
    const anchor = alter(anchorFor(document, 7, 11));
    const before = Y.encodeStateAsUpdate(document);

    expect(applyCollaborativeProposalBatch(document, identity(document), [{
      anchor,
      mode: "replace",
      proposalId: "proposal_beta",
      replacementText: "BETTER",
    }])).toEqual({ ok: false, reason: "proposal_target_conflict" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it("rejects reversed and wrong-fragment anchors without mutation", () => {
    const document = createDocument("alpha beta gamma");
    const early = anchorFor(document, 7, 8);
    const late = anchorFor(document, 10, 11);
    const other = document.getXmlFragment("private");
    other.insert(0, [new Y.XmlText("secret")]);
    const privateStart = Y.createRelativePositionFromTypeIndex(other, 0, -1);
    const privateEnd = Y.createRelativePositionFromTypeIndex(other, 1, 1);
    const candidates = [
      { ...early, startRelative: late.startRelative, targetHash: sha256("") },
      {
        ...early,
        endRelative: Y.encodeRelativePosition(privateEnd),
        startRelative: Y.encodeRelativePosition(privateStart),
        targetHash: sha256("secret"),
      },
    ];

    for (const anchor of candidates) {
      const before = Y.encodeStateAsUpdate(document);
      expect(applyCollaborativeProposalBatch(document, identity(document), [{
        anchor,
        mode: "replace",
        proposalId: "proposal_invalid",
        replacementText: "x",
      }])).toEqual({ ok: false, reason: "proposal_target_conflict" });
      expect(Y.encodeStateAsUpdate(document)).toEqual(before);
    }
  });

  it("rejects an overlapping batch atomically", () => {
    const document = createDocument("alpha beta gamma");
    const before = Y.encodeStateAsUpdate(document);

    expect(applyCollaborativeProposalBatch(document, identity(document), [
      {
        anchor: anchorFor(document, 1, 11),
        mode: "replace",
        proposalId: "proposal_alpha_beta",
        replacementText: "one",
      },
      {
        anchor: anchorFor(document, 7, 16),
        mode: "replace",
        proposalId: "proposal_beta_gamma",
        replacementText: "two",
      },
    ])).toEqual({ ok: false, reason: "proposal_overlap_conflict" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it("validates the complete batch before one Yjs transaction", () => {
    const document = createDocument("alpha beta gamma");
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));

    const result = applyCollaborativeProposalBatch(document, identity(document), [
      {
        anchor: anchorFor(document, 1, 6),
        mode: "replace",
        proposalId: "proposal_alpha",
        replacementText: "A",
      },
      {
        anchor: anchorFor(document, 12, 17),
        mode: "replace",
        proposalId: "proposal_gamma",
        replacementText: "G",
      },
    ]);

    expect(result).toMatchObject({ ok: true, proposalIds: ["proposal_alpha", "proposal_gamma"] });
    expect(updates).toHaveLength(1);
    expect(codec.materialize(document).plainText).toBe("A beta G");
  });

  it("rejects duplicate Proposal ids before mutation", () => {
    const document = createDocument("alpha beta gamma");
    const before = Y.encodeStateAsUpdate(document);
    const anchor = anchorFor(document, 7, 11);

    expect(applyCollaborativeProposalBatch(document, identity(document), [
      { anchor, mode: "replace", proposalId: "duplicate", replacementText: "one" },
      { anchor, mode: "replace", proposalId: "duplicate", replacementText: "two" },
    ])).toEqual({ ok: false, reason: "proposal_overlap_conflict" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });
});

function identity(
  document: Y.Doc,
  overrides: Partial<{ generation: number; headSeq: number; schemaFingerprint: string }> = {},
) {
  return {
    generation: overrides.generation ?? 1,
    headSeq: overrides.headSeq ?? 8,
    schemaFingerprint: overrides.schemaFingerprint ?? codec.fingerprint(),
    stateVector: Y.encodeStateVector(document),
  };
}

function anchorFor(document: Y.Doc, from: number, to: number) {
  return createCollaborativeProposalAnchor(document, {
    baseHeadSeq: 7,
    generation: 1,
    range: { from, to },
    schemaFingerprint: codec.fingerprint(),
  });
}

function createDocument(text: string) {
  return codec.bootstrap({
    contentJson: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    metadataJson: {},
    plainText: text,
    title: "Proposal command",
  });
}

function firstXmlText(document: Y.Doc): Y.XmlText {
  const queue: Array<Y.XmlElement | Y.XmlFragment> = [document.getXmlFragment(COLLABORATION_BODY_NAME)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of current.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) queue.push(child);
    }
  }
  throw new Error("Expected collaborative text");
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
