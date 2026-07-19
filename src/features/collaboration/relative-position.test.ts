import { getSchema } from "@tiptap/core";
import { initProseMirrorDoc } from "y-prosemirror";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { createServerSchemaExtensions } from "@/plugins/document-schema-profile";

import { COLLABORATION_BODY_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  createEncodedRelativeRange,
  resolveEncodedRelativeRange,
  type EncodedRelativeRange,
} from "./relative-position";

const schema = getSchema(createServerSchemaExtensions());

describe("collaboration relative ranges", () => {
  it("round-trips an exact body range with explicit boundary associations", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });

    expect(range.startAssoc).toBe(-1);
    expect(range.endAssoc).toBe(1);
    expect(resolveEncodedRelativeRange(document, range)).toEqual({
      from: 7,
      ok: true,
      to: 11,
    });
    expect(textForRange(document, range)).toBe("beta");
  });

  it("keeps the target stable across inserts before, inside, and after the range", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });
    const text = firstXmlText(document);

    text.insert(0, "before ");
    expect(textForRange(document, range)).toBe("beta");

    text.insert("before alpha be".length, "X");
    expect(textForRange(document, range)).toBe("beXta");

    text.insert(text.length, " after");
    expect(textForRange(document, range)).toBe("beXta");
  });

  it("resolves a deleted target to a non-reversed collapsed boundary", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });
    firstXmlText(document).delete(6, 4);

    const result = resolveEncodedRelativeRange(document, range);
    expectEncodedAssociations(range);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected a resolved range");
    expect(result.from).toBe(result.to);
    expect(textForRange(document, range)).toBe("");
  });

  it("tracks the same target when content before it is deleted", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });
    firstXmlText(document).delete(0, 6);

    expectEncodedAssociations(range);
    expect(resolveEncodedRelativeRange(document, range)).toEqual({ from: 1, ok: true, to: 5 });
    expect(textForRange(document, range)).toBe("beta");
  });

  it("shrinks to the surviving target text when content inside it is partially deleted", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });
    firstXmlText(document).delete(7, 2);

    expectEncodedAssociations(range);
    expect(resolveEncodedRelativeRange(document, range)).toEqual({ from: 7, ok: true, to: 9 });
    expect(textForRange(document, range)).toBe("ba");
  });

  it("keeps the target unchanged when content after it is deleted", () => {
    const document = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(document, { from: 7, to: 11 });
    firstXmlText(document).delete(10, 6);

    expectEncodedAssociations(range);
    expect(resolveEncodedRelativeRange(document, range)).toEqual({ from: 7, ok: true, to: 11 });
    expect(textForRange(document, range)).toBe("beta");
  });

  it("returns missing when an anchor does not exist in the target document", () => {
    const source = createDocument("alpha beta gamma");
    const target = createDocument("alpha beta gamma");
    const range = createEncodedRelativeRange(source, { from: 7, to: 11 });

    expect(resolveEncodedRelativeRange(target, range)).toEqual({ ok: false, reason: "missing" });
  });

  it("returns reversed when decoded body anchors cross", () => {
    const document = createDocument("alpha beta gamma");
    const early = createEncodedRelativeRange(document, { from: 7, to: 8 });
    const late = createEncodedRelativeRange(document, { from: 10, to: 11 });
    const reversed: EncodedRelativeRange = {
      end: early.end,
      endAssoc: 1,
      start: late.start,
      startAssoc: -1,
    };

    expect(resolveEncodedRelativeRange(document, reversed)).toEqual({ ok: false, reason: "reversed" });
  });

  it("returns wrong_fragment instead of falling back to another shared type", () => {
    const document = createDocument("alpha beta gamma");
    const other = document.getXmlFragment("other");
    other.insert(0, [new Y.XmlText("private")]);
    const start = new Y.RelativePosition(
      Y.createRelativePositionFromTypeIndex(other, 0).type,
      Y.createRelativePositionFromTypeIndex(other, 0).tname,
      Y.createRelativePositionFromTypeIndex(other, 0).item,
      -1,
    );
    const end = new Y.RelativePosition(
      Y.createRelativePositionFromTypeIndex(other, 1).type,
      Y.createRelativePositionFromTypeIndex(other, 1).tname,
      Y.createRelativePositionFromTypeIndex(other, 1).item,
      1,
    );
    const range: EncodedRelativeRange = {
      end: Y.encodeRelativePosition(end),
      endAssoc: 1,
      start: Y.encodeRelativePosition(start),
      startAssoc: -1,
    };

    expect(resolveEncodedRelativeRange(document, range)).toEqual({
      ok: false,
      reason: "wrong_fragment",
    });
  });

  it("rejects invalid absolute and association contracts without a fallback", () => {
    const document = createDocument("alpha beta gamma");

    expect(() => createEncodedRelativeRange(document, { from: 11, to: 7 }))
      .toThrowError("Invalid collaboration body range");
    expect(() => createEncodedRelativeRange(document, { from: -1, to: 2 }))
      .toThrowError("Invalid collaboration body range");

    const valid = createEncodedRelativeRange(document, { from: 7, to: 11 });
    expect(resolveEncodedRelativeRange(document, { ...valid, startAssoc: 1 as -1 })).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

function createDocument(text: string) {
  return createCollaborationDocumentCodec(getProjectProfile("default")).bootstrap({
    contentJson: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    metadataJson: {},
    plainText: text,
    title: "Relative positions",
  });
}

function firstXmlText(document: Y.Doc): Y.XmlText {
  const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  const queue: Array<Y.XmlElement | Y.XmlFragment> = [body];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const child of current.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) queue.push(child);
    }
  }
  throw new Error("Expected collaborative text");
}

function textForRange(document: Y.Doc, range: EncodedRelativeRange) {
  const resolution = resolveEncodedRelativeRange(document, range);
  if (!resolution.ok) throw new Error(`Expected resolved range: ${resolution.reason}`);
  const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
  const { doc } = initProseMirrorDoc(body, schema);
  return doc.textBetween(resolution.from, resolution.to);
}

function expectEncodedAssociations(range: EncodedRelativeRange) {
  expect(range).toMatchObject({ endAssoc: 1, startAssoc: -1 });
  expect(Y.decodeRelativePosition(range.start).assoc).toBe(-1);
  expect(Y.decodeRelativePosition(range.end).assoc).toBe(1);
}
