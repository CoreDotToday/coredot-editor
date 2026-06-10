import type { AiCommandPayload } from "./types";
import { getDocumentsByIds } from "@/features/documents/document-repository";

export type HydratedAiReferenceDocument = {
  id: string;
  text: string;
  title: string;
};

export async function hydrateAiReferenceDocuments(
  references: AiCommandPayload["references"],
): Promise<HydratedAiReferenceDocument[]> {
  const ids = Array.from(new Set(references.documents.map((document) => document.documentId)));
  const documents = await getDocumentsByIds(ids);

  return documents.map((document) => ({
    id: document.id,
    text: document.plainText,
    title: document.title,
  }));
}
