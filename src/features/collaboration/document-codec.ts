import "server-only";

import { createHash } from "node:crypto";

import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";

import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import { validateProjectMetadata, type ProjectProfile } from "@/features/projects/project-profile";
import { validateTiptapResource } from "@/features/security/resource-policy";
import {
  createServerSchemaExtensions,
  defaultDocumentSchemaProfile,
} from "@/plugins/document-schema-profile";

import {
  COLLABORATION_BODY_NAME,
  COLLABORATION_DOCUMENT_LAYOUT_VERSION,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TIPTAP_SCHEMA_VERSION,
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
  | { fieldId: string; ok: false };

type CollaborationValidationResult =
  | { ok: true; value: CollaborationMaterialization }
  | CollaborationValidationFailure;

export type CollaborationSchemaExtensionDescriptor = {
  name: string;
  version: string;
};

export const COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS = [
  { name: "starterKit", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
  { name: "link", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
  { name: "taskList", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
  { name: "taskItem", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
  { name: "tableKit", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
  { name: "typography", version: COLLABORATION_TIPTAP_SCHEMA_VERSION },
] as const satisfies readonly CollaborationSchemaExtensionDescriptor[];

export class CollaborationCodecError extends Error {
  override readonly name = "CollaborationCodecError";

  constructor(readonly failure: CollaborationValidationFailure) {
    super("Collaboration document is invalid");
  }
}

export function createCollaborationDocumentCodec(
  projectProfile: ProjectProfile,
): CollaborationDocumentCodec {
  const extensions = createServerSchemaExtensions();
  const schema = getSchema(extensions);
  assertSchemaExtensionDescriptors(extensions.map((extension) => extension.name));
  const schemaFingerprint = createCollaborationSchemaFingerprint({
    projectProfileId: projectProfile.id,
  });

  const codec: CollaborationDocumentCodec = {
    bootstrap(snapshot) {
      const snapshotResult = validateSnapshot(snapshot, projectProfile, schema);
      if (!snapshotResult.ok) throw new CollaborationCodecError(snapshotResult);

      const document = new Y.Doc();
      const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
      const title = document.getText(COLLABORATION_TITLE_NAME);
      const metadata = document.getMap<CollaborationMetadataValue>(COLLABORATION_METADATA_NAME);
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
      const document = new Y.Doc();
      Y.applyUpdate(document, checkpoint, "checkpoint-load");
      return document;
    },

    materialize(document) {
      const result = validateDocument(document, projectProfile, schema);
      if (!result.ok) throw new CollaborationCodecError(result);
      return result.value;
    },

    validate(document, profile) {
      if (profile.id !== projectProfile.id) {
        throw new CollaborationCodecError({ ok: false, reason: "profile_mismatch" });
      }
      const result = validateDocument(document, profile, schema);
      if (!result.ok) throw new CollaborationCodecError(result);
      return result.value;
    },
  };

  return codec;
}

export function createCollaborationSchemaFingerprint({
  extensionDescriptors = COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS,
  projectProfileId,
  schemaVersion = COLLABORATION_DOCUMENT_SCHEMA_VERSION,
}: {
  extensionDescriptors?: readonly CollaborationSchemaExtensionDescriptor[];
  projectProfileId: string;
  schemaVersion?: number;
}) {
  const descriptor = {
    defaultSchemaProfileId: defaultDocumentSchemaProfile.id,
    extensionDescriptors,
    layout: {
      body: COLLABORATION_BODY_NAME,
      metadata: COLLABORATION_METADATA_NAME,
      title: COLLABORATION_TITLE_NAME,
    },
    layoutVersion: COLLABORATION_DOCUMENT_LAYOUT_VERSION,
    projectProfileId,
    schemaVersion,
  };
  return createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
}

function assertSchemaExtensionDescriptors(actualNames: readonly string[]) {
  const describedNames = COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS.map(({ name }) => name);
  if (
    actualNames.length !== describedNames.length
    || actualNames.some((name, index) => name !== describedNames[index])
  ) {
    throw new Error("Collaboration schema extension descriptors do not match the server schema");
  }
}

function validateSnapshot(
  snapshot: CollaborationMaterialization,
  profile: ProjectProfile,
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
  profile: ProjectProfile,
  schema: Schema,
): CollaborationValidationResult {
  const title = document.getText(COLLABORATION_TITLE_NAME).toString();
  const titleFailure = validateTitle(title);
  if (titleFailure) return titleFailure;

  const metadata = decodeMetadata(document.getMap(COLLABORATION_METADATA_NAME));
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

  let prosemirrorDocument: ProseMirrorNode;
  try {
    prosemirrorDocument = yXmlFragmentToProseMirrorRootNode(
      document.getXmlFragment(COLLABORATION_BODY_NAME),
      schema,
    );
  } catch {
    return { ok: false, reason: "content_schema" };
  }
  const contentJson = prosemirrorDocument.toJSON() as CollaborationTiptapJson;
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

function validateTitle(title: string): CollaborationValidationFailure | undefined {
  if (title.trim().length === 0) return { ok: false, reason: "title_blank" };
  if (title.length > COLLABORATION_TITLE_MAX_LENGTH) {
    return { ok: false, reason: "title_too_long" };
  }
  return undefined;
}

function decodeMetadata(metadata: Y.Map<unknown>): MetadataDecodeResult {
  const value: CollaborationMetadata = {};
  for (const [fieldId, candidate] of metadata.entries()) {
    if (!isMetadataValue(candidate)) return { fieldId, ok: false };
    value[fieldId] = cloneMetadataValue(candidate);
  }
  return { ok: true, value };
}

function isMetadataValue(candidate: unknown): candidate is CollaborationMetadataValue {
  return candidate === null
    || typeof candidate === "boolean"
    || (typeof candidate === "number" && Number.isFinite(candidate))
    || typeof candidate === "string"
    || (Array.isArray(candidate) && candidate.every((item) => typeof item === "string"));
}

function cloneMetadataValue(value: CollaborationMetadataValue): CollaborationMetadataValue {
  return Array.isArray(value) ? [...value] : value;
}
