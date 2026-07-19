import type * as Y from "yjs";

import type { ProjectMetadataValidationResult, ProjectProfile } from "@/features/projects/project-profile";

export const COLLABORATION_BODY_NAME = "body";
export const COLLABORATION_TITLE_NAME = "title";
export const COLLABORATION_METADATA_NAME = "metadata";
export const COLLABORATION_DOCUMENT_LAYOUT_VERSION = "coredot.collaboration.document.v1";
export const COLLABORATION_DOCUMENT_SCHEMA_VERSION = 1;
export const COLLABORATION_TITLE_MAX_LENGTH = 500;

export type CollaborationTiptapJson = {
  content?: unknown[];
  type: "doc";
};

export type CollaborationMetadataValue = boolean | number | string | string[] | null;
export type CollaborationMetadata = Record<string, CollaborationMetadataValue>;

export type CollaborationDocumentIdentity = {
  generation: number;
  schemaFingerprint: string;
  schemaVersion: number;
};

export type CollaborationMaterialization = {
  contentJson: CollaborationTiptapJson;
  metadataJson: CollaborationMetadata;
  plainText: string;
  title: string;
};

export type CollaborationValidationFailure =
  | { ok: false; reason: "checkpoint_invalid" | "shared_type_mismatch" }
  | { ok: false; reason: "content_schema" }
  | {
      limit: "documentDepth" | "documentJsonBytes" | "documentNodes" | "malformed";
      ok: false;
      reason: "content_resource";
    }
  | { ok: false; reason: "title_blank" | "title_too_long" }
  | { ok: false; reason: "profile_mismatch" }
  | { fieldId?: string; ok: false; reason: "metadata_structure" }
  | {
      fieldId: string;
      metadataReason: Exclude<ProjectMetadataValidationResult, { ok: true }>["reason"];
      ok: false;
      reason: "metadata_invalid";
    };

export interface CollaborationDocumentCodec {
  bootstrap(snapshot: CollaborationMaterialization): Y.Doc;
  encodeCheckpoint(document: Y.Doc): Uint8Array;
  fingerprint(): string;
  loadCheckpoint(checkpoint: Uint8Array): Y.Doc;
  materialize(document: Y.Doc): CollaborationMaterialization;
  validate(document: Y.Doc, profile: ProjectProfile): CollaborationMaterialization;
}
