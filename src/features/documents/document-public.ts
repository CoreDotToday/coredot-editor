import type { DocumentRecord } from "@/db/schema";

export type PublicDocumentRecord = Omit<DocumentRecord, "creationKey">;

/**
 * Maps a database record to the document shape that may cross an API or
 * server-to-client boundary. Keep this projection explicit so internal
 * persistence fields are not exposed when the database schema grows.
 */
export function toPublicDocument(document: DocumentRecord): PublicDocumentRecord {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    title: document.title,
    contentJson: document.contentJson,
    plainText: document.plainText,
    status: document.status,
    readiness: document.readiness,
    metadataJson: document.metadataJson,
    revision: document.revision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}
