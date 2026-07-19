import { createHash } from "node:crypto";

import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";

import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import {
  getProjectMetadataFieldLimits,
  validateProjectMetadata,
  type ProjectMetadataContract,
  type ProjectMetadataField,
  type ProjectProfile,
} from "@/features/projects/project-profile";
import { RESOURCE_LIMITS, validateTiptapResource } from "@/features/security/resource-policy";
import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";
import {
  createServerSchemaExtensions,
  type DocumentSchemaProfile,
} from "@/plugins/document-schema-profile";

import {
  COLLABORATION_BODY_NAME,
  COLLABORATION_DOCUMENT_LAYOUT_VERSION,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_MAX_LENGTH,
  COLLABORATION_TITLE_NAME,
  type CollaborationDocumentCodec,
  type CollaborationMaterialization,
  type CollaborationMetadata,
  type CollaborationMetadataValue,
  type CollaborationTiptapJson,
  type CollaborationValidationFailure,
} from "./contracts";

type MetadataDecodeResult =
  | { ok: true; value: CollaborationMetadata }
  | { fieldId?: string; ok: false };

type CollaborationValidationResult =
  | { ok: true; value: CollaborationMaterialization }
  | CollaborationValidationFailure;

type CollaborationSharedRoots = {
  body: Y.XmlFragment;
  metadata: Y.Map<unknown>;
  title: Y.Text;
};

type CapturedCollaborationProjectProfile = ProjectMetadataContract & { id: string };
type SharedRoot = Y.Doc["share"] extends Map<string, infer Root> ? Root : never;

type CollaborationSchemaExtensionDescriptor = {
  name: string;
  version: string;
};

type CollaborationMetadataFieldDescriptor = {
  id: string;
  limits: {
    itemMaxLength: number | null;
    maxItems: number | null;
    maxLength: number | null;
  };
  options: readonly string[] | null;
  required: boolean;
  type: ProjectMetadataField["type"];
};

type CollaborationProjectProfileDescriptor = {
  id: string;
  metadataFields: readonly CollaborationMetadataFieldDescriptor[];
};

type CapturedSchemaContract = {
  extensionDescriptors: readonly CollaborationSchemaExtensionDescriptor[];
  schemaProfileId: string;
};

const TIPTAP_SCHEMA_VERSION = "3.27.4";
const COLLABORATION_METADATA_LIMITS = Object.freeze({
  cumulativeBytes: 1024 * 1024,
  fieldIdCodeUnits: 128,
  fields: 256,
  stringArrayItems: 128,
  stringCodeUnits: 8_192,
  stringItemCodeUnits: 1_024,
});
const COLLABORATION_XML_ATTRIBUTE_LIMIT = 256;
const COLLABORATION_XML_ATTRIBUTE_NAME_CODE_UNITS = 128;
const COLLABORATION_XML_ATTRIBUTE_VALUE_CODE_UNITS = 8_192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export class CollaborationCodecError extends Error {
  override readonly name = "CollaborationCodecError";

  constructor(readonly failure: CollaborationValidationFailure) {
    super("Collaboration document is invalid");
  }
}

export function createCollaborationDocumentCodec(
  projectProfile: ProjectProfile,
  options: { schemaProfile?: DocumentSchemaProfile } = {},
): CollaborationDocumentCodec {
  const capturedProjectProfile = captureProjectProfile(projectProfile);
  const schemaProfile = options.schemaProfile ?? appDocumentSchemaProfileRuntime;
  const extensions = createServerSchemaExtensions(schemaProfile);
  const schema = getSchema(extensions);
  const schemaContract = captureSchemaContract(
    schemaProfile.id,
    extensions.map((extension) => extension.name),
  );
  const schemaFingerprint = createCollaborationSchemaFingerprint(
    capturedProjectProfile,
    schemaContract,
  );

  const codec: CollaborationDocumentCodec = {
    bootstrap(snapshot) {
      const snapshotResult = validateSnapshot(snapshot, capturedProjectProfile, schema);
      if (!snapshotResult.ok) throw new CollaborationCodecError(snapshotResult);

      const document = new Y.Doc();
      const roots = acquireSharedRoots(document);
      if (!roots) {
        throw new CollaborationCodecError({ ok: false, reason: "shared_type_mismatch" });
      }
      const { body, title } = roots;
      const metadata = roots.metadata as Y.Map<CollaborationMetadataValue>;
      const prosemirrorDocument = schema.nodeFromJSON(snapshotResult.value.contentJson);

      document.transact(() => {
        prosemirrorToYXmlFragment(prosemirrorDocument, body);
        title.insert(0, snapshotResult.value.title);
        for (const [fieldId, value] of Object.entries(snapshotResult.value.metadataJson)) {
          metadata.set(fieldId, cloneMetadataValue(value));
        }
      }, "sql-bootstrap");

      return document;
    },

    encodeCheckpoint(document) {
      return Y.encodeStateAsUpdate(document);
    },

    fingerprint() {
      return schemaFingerprint;
    },

    loadCheckpoint(checkpoint) {
      if (checkpoint.byteLength === 0 || checkpoint.byteLength > RESOURCE_LIMITS.documentJsonBytes) {
        throw new CollaborationCodecError({ ok: false, reason: "checkpoint_invalid" });
      }
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, checkpoint, "checkpoint-load");
      } catch {
        throw new CollaborationCodecError({ ok: false, reason: "checkpoint_invalid" });
      }
      const roots = acquireSharedRoots(document);
      if (!roots) {
        throw new CollaborationCodecError({ ok: false, reason: "shared_type_mismatch" });
      }
      let bodyPreflight: CollaborationValidationFailure | undefined;
      try {
        bodyPreflight = preflightBody(roots.body);
      } catch {
        throw new CollaborationCodecError({ ok: false, reason: "shared_type_mismatch" });
      }
      if (bodyPreflight?.reason === "content_schema") {
        throw new CollaborationCodecError({ ok: false, reason: "shared_type_mismatch" });
      }
      if (bodyPreflight) throw new CollaborationCodecError(bodyPreflight);
      return document;
    },

    materialize(document) {
      const result = validateDocument(document, capturedProjectProfile, schema);
      if (!result.ok) throw new CollaborationCodecError(result);
      return result.value;
    },

    validate(document, profile) {
      let suppliedFingerprint: string;
      try {
        suppliedFingerprint = createCollaborationSchemaFingerprint(
          captureProjectProfile(profile),
          schemaContract,
        );
      } catch {
        throw new CollaborationCodecError({ ok: false, reason: "profile_mismatch" });
      }
      if (suppliedFingerprint !== schemaFingerprint) {
        throw new CollaborationCodecError({ ok: false, reason: "profile_mismatch" });
      }
      const result = validateDocument(document, capturedProjectProfile, schema);
      if (!result.ok) throw new CollaborationCodecError(result);
      return result.value;
    },
  };

  return codec;
}

function createCollaborationSchemaFingerprint(
  projectProfile: CapturedCollaborationProjectProfile,
  schemaContract: CapturedSchemaContract,
) {
  const descriptor = {
    extensionDescriptors: schemaContract.extensionDescriptors,
    layout: {
      body: COLLABORATION_BODY_NAME,
      metadata: COLLABORATION_METADATA_NAME,
      title: COLLABORATION_TITLE_NAME,
    },
    layoutVersion: COLLABORATION_DOCUMENT_LAYOUT_VERSION,
    projectProfile: createCollaborationProjectProfileDescriptor(projectProfile),
    schemaProfileId: schemaContract.schemaProfileId,
    schemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
}

function createSchemaExtensionDescriptors(extensionNames: readonly string[]) {
  return extensionNames.map((name) => ({
    name,
    version: TIPTAP_SCHEMA_VERSION,
  }));
}

function captureSchemaContract(
  schemaProfileId: string,
  extensionNames: readonly string[],
): CapturedSchemaContract {
  return Object.freeze({
    extensionDescriptors: Object.freeze(
      createSchemaExtensionDescriptors(extensionNames).map((descriptor) => Object.freeze(descriptor)),
    ),
    schemaProfileId,
  });
}

function createCollaborationProjectProfileDescriptor(
  profile: CapturedCollaborationProjectProfile,
): CollaborationProjectProfileDescriptor {
  return {
    id: profile.id,
    metadataFields: profile.metadataFields
      .map((field) => {
        const limits = getProjectMetadataFieldLimits(field);
        return {
          id: field.id,
          limits: {
            itemMaxLength: limits.itemMaxLength ?? null,
            maxItems: limits.maxItems ?? null,
            maxLength: limits.maxLength ?? null,
          },
          options: field.options ? [...field.options].sort(compareStrings) : null,
          required: field.required === true,
          type: field.type,
        };
      })
      .sort((left, right) => compareStrings(left.id, right.id)),
  };
}

function captureProjectProfile(profile: ProjectProfile): CapturedCollaborationProjectProfile {
  const metadataFields = profile.metadataFields.map((field) => Object.freeze({
    id: field.id,
    itemMaxLength: field.itemMaxLength,
    maxItems: field.maxItems,
    maxLength: field.maxLength,
    options: field.options ? Object.freeze([...field.options]) : undefined,
    required: field.required,
    type: field.type,
  }));
  return Object.freeze({
    id: profile.id,
    metadataFields: Object.freeze(metadataFields),
  });
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateSnapshot(
  snapshot: CollaborationMaterialization,
  profile: CapturedCollaborationProjectProfile,
  schema: Schema,
): CollaborationValidationResult {
  const titleFailure = validateTitle(snapshot.title);
  if (titleFailure) return titleFailure;

  const resourceValidation = validateTiptapResource(snapshot.contentJson);
  if (!resourceValidation.ok) {
    return { limit: resourceValidation.limit, ok: false, reason: "content_resource" };
  }
  try {
    schema.nodeFromJSON(snapshot.contentJson).check();
  } catch {
    return { ok: false, reason: "content_schema" };
  }

  const metadataResult = validateProjectMetadata(profile, snapshot.metadataJson, {}, { enforceRequired: false });
  if (!metadataResult.ok) {
    return {
      fieldId: metadataResult.fieldId,
      metadataReason: metadataResult.reason,
      ok: false,
      reason: "metadata_invalid",
    };
  }

  return {
    ok: true,
    value: {
      contentJson: snapshot.contentJson,
      metadataJson: metadataResult.value,
      plainText: extractPlainTextFromTiptap(snapshot.contentJson),
      title: snapshot.title,
    },
  };
}

function validateDocument(
  document: Y.Doc,
  profile: CapturedCollaborationProjectProfile,
  schema: Schema,
): CollaborationValidationResult {
  const roots = acquireSharedRoots(document);
  if (!roots) return { ok: false, reason: "shared_type_mismatch" };
  const sharedTitle = roots.title;
  if (sharedTitle.length > COLLABORATION_TITLE_MAX_LENGTH) {
    return { ok: false, reason: "title_too_long" };
  }
  let title: string;
  try {
    title = sharedTitle.toString();
  } catch {
    return { ok: false, reason: "shared_type_mismatch" };
  }
  const titleFailure = validateTitle(title);
  if (titleFailure) return titleFailure;

  let metadata: MetadataDecodeResult;
  try {
    metadata = decodeMetadata(roots.metadata);
  } catch {
    return { ok: false, reason: "shared_type_mismatch" };
  }
  if (!metadata.ok) {
    return { fieldId: metadata.fieldId, ok: false, reason: "metadata_structure" };
  }
  const metadataResult = validateProjectMetadata(profile, metadata.value, {}, { enforceRequired: false });
  if (!metadataResult.ok) {
    return {
      fieldId: metadataResult.fieldId,
      metadataReason: metadataResult.reason,
      ok: false,
      reason: "metadata_invalid",
    };
  }

  const body = roots.body;
  let bodyPreflight: CollaborationValidationFailure | undefined;
  try {
    bodyPreflight = preflightBody(body);
  } catch {
    return { ok: false, reason: "shared_type_mismatch" };
  }
  if (bodyPreflight) return bodyPreflight;

  let contentJson: CollaborationTiptapJson;
  let prosemirrorDocument: ProseMirrorNode;
  try {
    prosemirrorDocument = yXmlFragmentToProseMirrorRootNode(
      body,
      schema,
    );
    contentJson = prosemirrorDocument.toJSON() as CollaborationTiptapJson;
  } catch {
    return { ok: false, reason: "content_schema" };
  }
  const resourceValidation = validateTiptapResource(contentJson);
  if (!resourceValidation.ok) {
    return { limit: resourceValidation.limit, ok: false, reason: "content_resource" };
  }
  try {
    prosemirrorDocument.check();
  } catch {
    return { ok: false, reason: "content_schema" };
  }

  return {
    ok: true,
    value: {
      contentJson,
      metadataJson: metadataResult.value,
      plainText: extractPlainTextFromTiptap(contentJson),
      title,
    },
  };
}

function acquireSharedRoots(document: Y.Doc): CollaborationSharedRoots | undefined {
  const existingBody = document.share.get(COLLABORATION_BODY_NAME);
  const existingMetadata = document.share.get(COLLABORATION_METADATA_NAME);
  const existingTitle = document.share.get(COLLABORATION_TITLE_NAME);
  if (
    !isCompatibleRoot(existingBody, Y.XmlFragment)
    || !isCompatibleRoot(existingMetadata, Y.Map)
    || !isCompatibleRoot(existingTitle, Y.Text)
  ) {
    return undefined;
  }
  try {
    return {
      body: document.getXmlFragment(COLLABORATION_BODY_NAME),
      metadata: document.getMap(COLLABORATION_METADATA_NAME),
      title: document.getText(COLLABORATION_TITLE_NAME),
    };
  } catch {
    return undefined;
  }
}

function isCompatibleRoot(
  root: SharedRoot | undefined,
  expectedConstructor: typeof Y.Map | typeof Y.Text | typeof Y.XmlFragment,
) {
  return !root || root.constructor === Y.AbstractType || root.constructor === expectedConstructor;
}

function validateTitle(title: string): CollaborationValidationFailure | undefined {
  if (title.trim().length === 0) return { ok: false, reason: "title_blank" };
  if (title.length > COLLABORATION_TITLE_MAX_LENGTH) {
    return { ok: false, reason: "title_too_long" };
  }
  return undefined;
}

function decodeMetadata(metadata: Y.Map<unknown>): MetadataDecodeResult {
  if (metadata.size > COLLABORATION_METADATA_LIMITS.fields) return { ok: false };
  const value: CollaborationMetadata = {};
  let cumulativeBytes = 0;
  for (const [fieldId, candidate] of metadata.entries()) {
    if (
      fieldId.length === 0
      || fieldId.length > COLLABORATION_METADATA_LIMITS.fieldIdCodeUnits
      || CONTROL_CHARACTERS.test(fieldId)
    ) {
      return { ok: false };
    }
    cumulativeBytes = addBoundedUtf8Bytes(
      fieldId,
      cumulativeBytes,
      COLLABORATION_METADATA_LIMITS.cumulativeBytes,
    );
    if (cumulativeBytes < 0) return { ok: false };
    if (Array.isArray(candidate)) {
      if (candidate.length > COLLABORATION_METADATA_LIMITS.stringArrayItems) return { ok: false };
      for (const item of candidate) {
        if (typeof item !== "string") return { fieldId, ok: false };
        if (item.length > COLLABORATION_METADATA_LIMITS.stringItemCodeUnits) return { ok: false };
        cumulativeBytes = addBoundedUtf8Bytes(
          item,
          cumulativeBytes,
          COLLABORATION_METADATA_LIMITS.cumulativeBytes,
        );
        if (cumulativeBytes < 0) return { ok: false };
      }
      value[fieldId] = [...candidate];
      continue;
    }
    if (!isMetadataScalar(candidate)) return { fieldId, ok: false };
    if (typeof candidate === "string") {
      if (candidate.length > COLLABORATION_METADATA_LIMITS.stringCodeUnits) return { ok: false };
      cumulativeBytes = addBoundedUtf8Bytes(
        candidate,
        cumulativeBytes,
        COLLABORATION_METADATA_LIMITS.cumulativeBytes,
      );
      if (cumulativeBytes < 0) return { ok: false };
    }
    value[fieldId] = candidate;
  }
  return { ok: true, value };
}

function preflightBody(body: Y.XmlFragment): CollaborationValidationFailure | undefined {
  if (body.length > RESOURCE_LIMITS.documentNodes) {
    return { limit: "documentNodes", ok: false, reason: "content_resource" };
  }
  const stack = body.toArray().map((node) => ({ depth: 1, node }));
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > RESOURCE_LIMITS.documentNodes) {
      return { limit: "documentNodes", ok: false, reason: "content_resource" };
    }
    if (current.depth > RESOURCE_LIMITS.documentDepth) {
      return { limit: "documentDepth", ok: false, reason: "content_resource" };
    }

    if (current.node instanceof Y.XmlText) {
      if (current.node.length > RESOURCE_LIMITS.documentJsonBytes - bytes) {
        return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
      }
      bytes = addBoundedUtf8Bytes(
        current.node.toString(),
        bytes,
        RESOURCE_LIMITS.documentJsonBytes,
      );
      if (bytes < 0) return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
    } else if (current.node instanceof Y.XmlElement) {
      bytes = addBoundedUtf8Bytes(
        current.node.nodeName,
        bytes,
        RESOURCE_LIMITS.documentJsonBytes,
      );
      if (bytes < 0) return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
      if (current.node.length > RESOURCE_LIMITS.documentNodes - nodes) {
        return { limit: "documentNodes", ok: false, reason: "content_resource" };
      }
      for (const child of current.node.toArray()) {
        stack.push({ depth: current.depth + 1, node: child });
      }
    } else {
      return { ok: false, reason: "content_schema" };
    }

    const attributes = current.node.getAttributes();
    const attributeEntries = Object.entries(attributes);
    if (attributeEntries.length > COLLABORATION_XML_ATTRIBUTE_LIMIT) {
      return { limit: "documentNodes", ok: false, reason: "content_resource" };
    }
    for (const [name, value] of attributeEntries) {
      if (
        name.length > COLLABORATION_XML_ATTRIBUTE_NAME_CODE_UNITS
        || value.length > COLLABORATION_XML_ATTRIBUTE_VALUE_CODE_UNITS
        || CONTROL_CHARACTERS.test(name)
      ) {
        return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
      }
      bytes = addBoundedUtf8Bytes(name, bytes, RESOURCE_LIMITS.documentJsonBytes);
      if (bytes < 0) return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
      bytes = addBoundedUtf8Bytes(value, bytes, RESOURCE_LIMITS.documentJsonBytes);
      if (bytes < 0) return { limit: "documentJsonBytes", ok: false, reason: "content_resource" };
    }
  }
  return undefined;
}

function addBoundedUtf8Bytes(value: string, current: number, limit: number) {
  let bytes = current;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        bytes += 4;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return -1;
  }
  return bytes;
}

function isMetadataScalar(candidate: unknown): candidate is Exclude<CollaborationMetadataValue, string[]> {
  return candidate === null
    || typeof candidate === "boolean"
    || (typeof candidate === "number" && Number.isFinite(candidate))
    || typeof candidate === "string";
}

function cloneMetadataValue(value: CollaborationMetadataValue): CollaborationMetadataValue {
  return Array.isArray(value) ? [...value] : value;
}
