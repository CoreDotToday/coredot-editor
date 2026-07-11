import type { AiCommandPayload } from "./types";
import { getDocumentsByIds } from "@/features/documents/document-repository";
import type { WorkspaceScope } from "@/features/auth/request-context";

export type HydratedAiReferenceDocument = {
  id: string;
  text: string;
  title: string;
};

export type HydrateAiReferenceDocumentsOptions = {
  currentDocumentId?: string;
};

export async function hydrateAiReferenceDocuments(
  scope: WorkspaceScope,
  references: AiCommandPayload["references"],
  options: HydrateAiReferenceDocumentsOptions = {},
): Promise<HydratedAiReferenceDocument[]> {
  const ids = Array.from(new Set(references.documents.map((document) => document.documentId))).filter(
    (documentId) => documentId !== options.currentDocumentId,
  );
  if (ids.length === 0) {
    return [];
  }

  const documents = await getDocumentsByIds(scope, ids);

  return documents.map((document) => ({
    id: document.id,
    text: document.plainText,
    title: document.title,
  }));
}
