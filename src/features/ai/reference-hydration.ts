import type { AiCommandPayload } from "./types";
import { getDocumentsByIds } from "@/features/documents/document-repository";

export type HydratedAiReferenceDocument = {
  id: string;
  text: string;
  title: string;
};

export type HydrateAiReferenceDocumentsOptions = {
  currentDocumentId?: string;
};

export async function hydrateAiReferenceDocuments(
  references: AiCommandPayload["references"],
  options: HydrateAiReferenceDocumentsOptions = {},
): Promise<HydratedAiReferenceDocument[]> {
  const ids = Array.from(new Set(references.documents.map((document) => document.documentId))).filter(
    (documentId) => documentId !== options.currentDocumentId,
  );
  if (ids.length === 0) {
    return [];
  }

  const documents = await getDocumentsByIds(ids);

  return documents.map((document) => ({
    id: document.id,
    text: document.plainText,
    title: document.title,
  }));
}
