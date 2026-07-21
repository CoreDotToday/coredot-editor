import { createHash } from "node:crypto";

import { getSchema } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc, updateYFragment } from "y-prosemirror";
import * as Y from "yjs";

import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";
import {
  createServerSchemaExtensions,
  type DocumentSchemaProfile,
} from "@/plugins/document-schema-profile";

import { COLLABORATION_BODY_NAME } from "./contracts";
import {
  createCollaborationRelativePositionCodec,
  type EncodedRelativeRange,
} from "./relative-position";

const TARGET_PREVIEW_BYTES = 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Transaction origin of every collaborative Proposal command. Selective undo
 * captures inverse updates from exactly this origin, so command mutations and
 * their undo boundary always agree.
 */
export const COLLABORATION_PROPOSAL_COMMAND_ORIGIN = "collaboration-proposal-command";

export type CollaborativeProposalAnchor = {
  baseHeadSeq: number;
  baseStateVector: Uint8Array;
  endAssoc: 1;
  endRelative: Uint8Array;
  generation: number;
  schemaFingerprint: string;
  startAssoc: -1;
  startRelative: Uint8Array;
  targetHash: string;
  targetPreview: string;
};

export type CollaborativeProposalCommandItem = {
  anchor: CollaborativeProposalAnchor;
  mode: "insert_below" | "replace";
  proposalId: string;
  replacementText: string;
};

export type CollaborativeProposalDocumentIdentity = {
  generation: number;
  headSeq: number;
  schemaFingerprint: string;
  stateVector: Uint8Array;
};

export type CollaborativeProposalCommandResult =
  | {
      affectedRanges: Array<{ from: number; proposalId: string; to: number }>;
      /** Post-command span covering every replacement and insertion. */
      changedRange: { from: number; to: number };
      ok: true;
      proposalIds: string[];
    }
  | { ok: false; reason: "proposal_overlap_conflict" | "proposal_target_conflict" };

export type CollaborativeProposalCommandCodec = {
  applyBatch(
    document: Y.Doc,
    identity: CollaborativeProposalDocumentIdentity,
    items: readonly CollaborativeProposalCommandItem[],
  ): CollaborativeProposalCommandResult;
  createAnchor(
    document: Y.Doc,
    input: {
      baseHeadSeq: number;
      generation: number;
      range: { from: number; to: number };
      schemaFingerprint: string;
    },
  ): CollaborativeProposalAnchor;
};

export function createCollaborativeProposalCommandCodec(
  schemaProfile: DocumentSchemaProfile = appDocumentSchemaProfileRuntime,
): CollaborativeProposalCommandCodec {
  const schema = getSchema(createServerSchemaExtensions(schemaProfile));
  const positions = createCollaborationRelativePositionCodec(schemaProfile);

  return {
    applyBatch(document, identity, items) {
      if (!isValidIdentity(identity) || items.length < 1 || items.length > 100) {
        return targetConflict();
      }
      const proposalIds = items.map(({ proposalId }) => proposalId);
      if (
        proposalIds.some((proposalId) => !isBoundedIdentifier(proposalId))
        || new Set(proposalIds).size !== proposalIds.length
      ) {
        return overlapConflict();
      }

      const body = acquireBody(document);
      if (!body) return targetConflict();
      let prosemirrorDocument: ProseMirrorNode;
      let mapping: ReturnType<typeof initProseMirrorDoc>["mapping"];
      let isOMark: ReturnType<typeof initProseMirrorDoc>["meta"]["isOMark"];
      try {
        const initialized = initProseMirrorDoc(body, schema);
        prosemirrorDocument = initialized.doc;
        mapping = initialized.mapping;
        isOMark = initialized.meta.isOMark;
      } catch {
        return targetConflict();
      }

      const resolved: Array<{
        from: number;
        insertionPosition: number | null;
        item: CollaborativeProposalCommandItem;
        to: number;
      }> = [];
      for (const item of items) {
        if (!isValidItem(item, identity)) return targetConflict();
        const range = positions.resolveEncodedRelativeRange(document, encodedRange(item.anchor));
        if (!range.ok || range.from >= range.to || range.to > prosemirrorDocument.content.size) {
          return targetConflict();
        }
        const targetText = prosemirrorDocument.textBetween(range.from, range.to, "\n", "\uFFFC");
        if (sha256(targetText) !== item.anchor.targetHash) return targetConflict();
        resolved.push({
          from: range.from,
          insertionPosition: item.mode === "insert_below"
            ? afterContainingTopLevelBlock(prosemirrorDocument, range.to)
            : null,
          item,
          to: range.to,
        });
      }

      const ascending = [...resolved].sort((left, right) =>
        left.from - right.from || left.to - right.to || left.item.proposalId.localeCompare(right.item.proposalId));
      for (let index = 1; index < ascending.length; index += 1) {
        const previous = ascending[index - 1]!;
        const current = ascending[index]!;
        if (current.from < previous.to) return overlapConflict();
      }
      const insertPositions = resolved.flatMap(({ insertionPosition }) =>
        insertionPosition === null ? [] : [insertionPosition]);
      if (new Set(insertPositions).size !== insertPositions.length) return overlapConflict();

      let transform = new Transform(prosemirrorDocument);
      try {
        for (const entry of [...resolved].sort((left, right) =>
          right.from - left.from || right.to - left.to || right.item.proposalId.localeCompare(left.item.proposalId))) {
          transform = applyItem(transform, entry);
        }
      } catch {
        return targetConflict();
      }

      document.transact(() => {
        updateYFragment(document, body, transform.doc, {
          isOMark,
          mapping,
        });
      }, COLLABORATION_PROPOSAL_COMMAND_ORIGIN);
      const changedRange = resolved.reduce(
        (range, { from, insertionPosition, to }) => {
          const spanFrom = insertionPosition ?? from;
          const spanTo = insertionPosition ?? to;
          return {
            from: Math.min(range.from, transform.mapping.map(spanFrom, -1)),
            to: Math.max(range.to, transform.mapping.map(spanTo, 1)),
          };
        },
        { from: Number.POSITIVE_INFINITY, to: 0 },
      );
      return {
        affectedRanges: resolved.map(({ from, item, to }) => ({
          from,
          proposalId: item.proposalId,
          to,
        })),
        changedRange,
        ok: true,
        proposalIds,
      };
    },

    createAnchor(document, input) {
      if (
        !Number.isSafeInteger(input.baseHeadSeq)
        || input.baseHeadSeq < 0
        || !Number.isSafeInteger(input.generation)
        || input.generation < 1
        || !SHA256_PATTERN.test(input.schemaFingerprint)
      ) {
        throw new Error("Invalid collaborative Proposal anchor");
      }
      const body = acquireBody(document);
      if (!body) throw new Error("Invalid collaborative Proposal anchor");
      const prosemirrorDocument = initProseMirrorDoc(body, schema).doc;
      const relative = positions.createEncodedRelativeRange(document, input.range);
      const targetText = prosemirrorDocument.textBetween(
        input.range.from,
        input.range.to,
        "\n",
        "\uFFFC",
      );
      return {
        baseHeadSeq: input.baseHeadSeq,
        baseStateVector: Y.encodeStateVector(document),
        endAssoc: relative.endAssoc,
        endRelative: relative.end,
        generation: input.generation,
        schemaFingerprint: input.schemaFingerprint,
        startAssoc: relative.startAssoc,
        startRelative: relative.start,
        targetHash: sha256(targetText),
        targetPreview: truncateUtf8(targetText, TARGET_PREVIEW_BYTES),
      };
    },
  };
}

const defaultCodec = createCollaborativeProposalCommandCodec();

export function createCollaborativeProposalAnchor(
  document: Y.Doc,
  input: Parameters<CollaborativeProposalCommandCodec["createAnchor"]>[1],
) {
  return defaultCodec.createAnchor(document, input);
}

export function applyCollaborativeProposalBatch(
  document: Y.Doc,
  identity: CollaborativeProposalDocumentIdentity,
  items: readonly CollaborativeProposalCommandItem[],
) {
  return defaultCodec.applyBatch(document, identity, items);
}

/**
 * Finds a review target in the exact collaborative ProseMirror body and maps
 * its plain-text offsets back to ProseMirror positions. Plain-text offsets are
 * deliberately never treated as document positions: block boundaries consume
 * ProseMirror positions even though materialized text represents them as a
 * single newline.
 */
export function findUniqueCollaborativeTextRange(
  document: Y.Doc,
  targetText: string,
  schemaProfile: DocumentSchemaProfile = appDocumentSchemaProfileRuntime,
): { from: number; to: number } | null {
  if (targetText.length === 0) return null;
  const body = acquireBody(document);
  if (!body) return null;
  let proseMirrorDocument: ProseMirrorNode;
  try {
    proseMirrorDocument = initProseMirrorDoc(
      body,
      getSchema(createServerSchemaExtensions(schemaProfile)),
    ).doc;
  } catch {
    return null;
  }

  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let previousTextEnd: number | null = null;
  proseMirrorDocument.descendants((node, position) => {
    if (!node.isText || typeof node.text !== "string") return true;
    if (previousTextEnd !== null && position > previousTextEnd) {
      text += "\n";
      starts.push(previousTextEnd);
      ends.push(position);
    }
    for (let index = 0; index < node.text.length; index += 1) {
      text += node.text[index]!;
      starts.push(position + index);
      ends.push(position + index + 1);
    }
    previousTextEnd = position + node.nodeSize;
    return false;
  });

  const first = text.indexOf(targetText);
  if (first < 0 || text.indexOf(targetText, first + 1) >= 0) return null;
  const last = first + targetText.length - 1;
  const from = starts[first];
  const to = ends[last];
  return from === undefined || to === undefined || from >= to ? null : { from, to };
}

function applyItem(
  transform: Transform,
  entry: { from: number; item: CollaborativeProposalCommandItem; to: number },
) {
  const { from, item, to } = entry;
  const lines = item.replacementText.split(/\r\n|\r|\n/);
  if (item.mode === "replace") {
    if (item.replacementText.length === 0) return transform.delete(from, to);
    if (lines.length === 1) {
      return transform.replaceWith(from, to, transform.doc.type.schema.text(item.replacementText));
    }
    const paragraphs = Fragment.from(lines.map((line) => createParagraph(transform, line)));
    return transform.replace(from, to, new Slice(paragraphs, 1, 1));
  }
  const insertionPosition = afterContainingTopLevelBlock(transform.doc, to);
  return transform.insert(
    insertionPosition,
    lines.map((line) => createParagraph(transform, line)),
  );
}

function createParagraph(transform: Transform, line: string) {
  const paragraph = transform.doc.type.schema.nodes.paragraph;
  if (!paragraph) throw new Error("Document schema has no paragraph");
  return paragraph.create(null, line.length === 0 ? undefined : transform.doc.type.schema.text(line));
}

function afterContainingTopLevelBlock(document: ProseMirrorNode, position: number) {
  const resolved = document.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth - 1) === document) return resolved.after(depth);
  }
  throw new Error("Proposal target is not inside a top-level block");
}

function encodedRange(anchor: CollaborativeProposalAnchor): EncodedRelativeRange {
  return {
    end: anchor.endRelative,
    endAssoc: anchor.endAssoc,
    start: anchor.startRelative,
    startAssoc: anchor.startAssoc,
  };
}

function isValidIdentity(identity: CollaborativeProposalDocumentIdentity) {
  return Number.isSafeInteger(identity.generation)
    && identity.generation >= 1
    && Number.isSafeInteger(identity.headSeq)
    && identity.headSeq >= 0
    && identity.stateVector instanceof Uint8Array
    && identity.stateVector.byteLength >= 1
    && identity.stateVector.byteLength <= 1024 * 1024
    && SHA256_PATTERN.test(identity.schemaFingerprint);
}

function isValidItem(
  item: CollaborativeProposalCommandItem,
  identity: CollaborativeProposalDocumentIdentity,
) {
  return item.anchor.generation === identity.generation
    && item.anchor.schemaFingerprint === identity.schemaFingerprint
    && Number.isSafeInteger(item.anchor.baseHeadSeq)
    && item.anchor.baseHeadSeq >= 0
    && item.anchor.baseHeadSeq <= identity.headSeq
    && item.anchor.baseStateVector instanceof Uint8Array
    && item.anchor.baseStateVector.byteLength >= 1
    && item.anchor.baseStateVector.byteLength <= 1024 * 1024
    && stateVectorIsIncluded(item.anchor.baseStateVector, identity.stateVector)
    && item.anchor.startRelative instanceof Uint8Array
    && item.anchor.startRelative.byteLength >= 1
    && item.anchor.startRelative.byteLength <= 64 * 1024
    && item.anchor.endRelative instanceof Uint8Array
    && item.anchor.endRelative.byteLength >= 1
    && item.anchor.endRelative.byteLength <= 64 * 1024
    && item.anchor.startAssoc === -1
    && item.anchor.endAssoc === 1
    && SHA256_PATTERN.test(item.anchor.targetHash)
    && (item.mode === "insert_below" || item.mode === "replace")
    && Buffer.byteLength(item.replacementText, "utf8") <= 1024 * 1024;
}

function stateVectorIsIncluded(
  encodedBase: Uint8Array,
  encodedCurrent: Uint8Array,
) {
  try {
    const base = Y.decodeStateVector(encodedBase);
    const current = Y.decodeStateVector(encodedCurrent);
    for (const [client, clock] of base) {
      if ((current.get(client) ?? 0) < clock) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isBoundedIdentifier(value: string) {
  return value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 256;
}

function acquireBody(document: Y.Doc) {
  const existing = document.share.get(COLLABORATION_BODY_NAME);
  if (existing && !(existing instanceof Y.XmlFragment)) return null;
  try {
    return document.getXmlFragment(COLLABORATION_BODY_NAME);
  } catch {
    return null;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function targetConflict(): CollaborativeProposalCommandResult {
  return { ok: false, reason: "proposal_target_conflict" };
}

function overlapConflict(): CollaborativeProposalCommandResult {
  return { ok: false, reason: "proposal_overlap_conflict" };
}
