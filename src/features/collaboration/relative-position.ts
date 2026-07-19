import { getSchema } from "@tiptap/core";
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import * as Y from "yjs";

import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";
import {
  createServerSchemaExtensions,
  type DocumentSchemaProfile,
} from "@/plugins/document-schema-profile";

import { COLLABORATION_BODY_NAME } from "./contracts";

export type EncodedRelativeRange = {
  end: Uint8Array;
  endAssoc: 1;
  start: Uint8Array;
  startAssoc: -1;
};

export type RelativeRangeResolution =
  | { from: number; ok: true; to: number }
  | { ok: false; reason: "missing" | "reversed" | "wrong_fragment" };

export type CollaborationRelativePositionCodec = {
  createEncodedRelativeRange(document: Y.Doc, range: { from: number; to: number }): EncodedRelativeRange;
  resolveEncodedRelativeRange(document: Y.Doc, range: EncodedRelativeRange): RelativeRangeResolution;
};

export function createCollaborationRelativePositionCodec(
  schemaProfile: DocumentSchemaProfile = appDocumentSchemaProfileRuntime,
): CollaborationRelativePositionCodec {
  const schema = getSchema(createServerSchemaExtensions(schemaProfile));
  return {
    createEncodedRelativeRange(document, range) {
      return createRange(schema, document, range);
    },
    resolveEncodedRelativeRange(document, range) {
      return resolveRange(schema, document, range);
    },
  };
}

const appRelativePositionCodec = createCollaborationRelativePositionCodec();

export function createEncodedRelativeRange(
  document: Y.Doc,
  range: { from: number; to: number },
): EncodedRelativeRange {
  return appRelativePositionCodec.createEncodedRelativeRange(document, range);
}

export function resolveEncodedRelativeRange(
  document: Y.Doc,
  range: EncodedRelativeRange,
): RelativeRangeResolution {
  return appRelativePositionCodec.resolveEncodedRelativeRange(document, range);
}

function createRange(
  schema: ReturnType<typeof getSchema>,
  document: Y.Doc,
  range: { from: number; to: number },
): EncodedRelativeRange {
  const body = acquireBody(document);
  if (!body) throw new Error("Invalid collaboration body range");
  const { doc, mapping } = initProseMirrorDoc(body, schema);
  if (
    !Number.isSafeInteger(range.from)
    || !Number.isSafeInteger(range.to)
    || range.from < 0
    || range.to < range.from
    || range.to > doc.content.size
  ) {
    throw new Error("Invalid collaboration body range");
  }

  const start = withAssociation(
    document,
    absolutePositionToRelativePosition(range.from, body, mapping) as Y.RelativePosition,
    -1,
  );
  const end = withAssociation(
    document,
    absolutePositionToRelativePosition(range.to, body, mapping) as Y.RelativePosition,
    1,
  );

  return {
    end: Y.encodeRelativePosition(end),
    endAssoc: 1,
    start: Y.encodeRelativePosition(start),
    startAssoc: -1,
  };
}

function resolveRange(
  schema: ReturnType<typeof getSchema>,
  document: Y.Doc,
  range: EncodedRelativeRange,
): RelativeRangeResolution {
  if (range.startAssoc !== -1 || range.endAssoc !== 1) {
    return { ok: false, reason: "missing" };
  }

  let start: Y.RelativePosition;
  let end: Y.RelativePosition;
  try {
    start = Y.decodeRelativePosition(range.start);
    end = Y.decodeRelativePosition(range.end);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (start.assoc !== -1 || end.assoc !== 1) return { ok: false, reason: "missing" };

  const body = acquireBody(document);
  if (!body) return { ok: false, reason: "wrong_fragment" };
  const startAbsolute = Y.createAbsolutePositionFromRelativePosition(start, document);
  const endAbsolute = Y.createAbsolutePositionFromRelativePosition(end, document);
  if (!startAbsolute || !endAbsolute) return { ok: false, reason: "missing" };
  if (!isBodyPosition(body, startAbsolute) || !isBodyPosition(body, endAbsolute)) {
    return { ok: false, reason: "wrong_fragment" };
  }

  const { mapping } = initProseMirrorDoc(body, schema);
  const from = relativePositionToAbsolutePosition(document, body, start, mapping);
  const to = relativePositionToAbsolutePosition(document, body, end, mapping);
  if (from === null || to === null) return { ok: false, reason: "missing" };
  if (from > to) return { ok: false, reason: "reversed" };
  return { from, ok: true, to };
}

function withAssociation(
  document: Y.Doc,
  position: Y.RelativePosition,
  association: -1 | 1,
) {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, document);
  if (!absolute) throw new Error("Invalid collaboration body range");
  const associated = Y.createRelativePositionFromTypeIndex(
    absolute.type,
    absolute.index,
    association,
  );
  return associated;
}

function isBodyPosition(body: Y.XmlFragment, position: Y.AbsolutePosition) {
  let current: Y.AbstractType<unknown> | null = position.type;
  while (current) {
    if (current === body) return true;
    current = current.parent;
  }
  return false;
}

function acquireBody(document: Y.Doc): Y.XmlFragment | undefined {
  const existing = document.share.get(COLLABORATION_BODY_NAME);
  if (
    existing
    && existing.constructor !== Y.AbstractType
    && existing.constructor !== Y.XmlFragment
  ) {
    return undefined;
  }
  try {
    return document.getXmlFragment(COLLABORATION_BODY_NAME);
  } catch {
    return undefined;
  }
}
