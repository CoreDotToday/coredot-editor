import { getProjectMetadataFieldLimits, type ProjectProfile } from "@/features/projects/project-profile";
import { appDocumentSchemaProfileRuntime } from "@/plugins/app-document-schema-profile-runtime.mjs";
import { createServerSchemaExtensions } from "@/plugins/document-schema-profile";

import {
  COLLABORATION_BODY_NAME,
  COLLABORATION_DOCUMENT_LAYOUT_VERSION,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_NAME,
} from "../contracts";
import { COLLABORATION_SCHEMA_PACKAGE_VERSIONS } from "../schema-package-versions";

export async function createBrowserCollaborationSchemaFingerprint(
  projectProfile: ProjectProfile,
) {
  if (!globalThis.crypto?.subtle) throw new Error("Schema fingerprint unavailable");

  const extensionDescriptors = createServerSchemaExtensions(appDocumentSchemaProfileRuntime)
    .map((extension) => ({
      name: extension.name,
      version: COLLABORATION_SCHEMA_PACKAGE_VERSIONS.tiptap,
    }));
  const descriptor = {
    extensionDescriptors,
    layout: {
      body: COLLABORATION_BODY_NAME,
      metadata: COLLABORATION_METADATA_NAME,
      title: COLLABORATION_TITLE_NAME,
    },
    layoutVersion: COLLABORATION_DOCUMENT_LAYOUT_VERSION,
    projectProfile: {
      id: projectProfile.id,
      metadataFields: projectProfile.metadataFields
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
    },
    schemaPackages: COLLABORATION_SCHEMA_PACKAGE_VERSIONS,
    schemaProfileId: appDocumentSchemaProfileRuntime.id,
    schemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  };
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(descriptor)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
