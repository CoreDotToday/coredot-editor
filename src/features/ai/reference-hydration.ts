import type { AiCommandPayload } from "./types";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { getAiReferenceProjectionsByIds } from "./reference-projection-repository";

export type HydratedAiReferenceDocument = {
  generation: number | null;
  id: string;
  projectedSeq: number | null;
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

  const documents = await getAiReferenceProjectionsByIds(scope, ids);

  return documents.map((document) => {
    assertValidProjectionDiagnostics(document);
    return {
      generation: document.generation,
      id: document.id,
      projectedSeq: document.projectedSeq,
      text: document.plainText,
      title: document.title,
    };
  });
}

function assertValidProjectionDiagnostics(document: {
  generation: number | null;
  headSeq: number | null;
  projectedSeq: number | null;
}) {
  if (
    document.generation === null
    && document.headSeq === null
    && document.projectedSeq === null
  ) {
    return;
  }
  if (
    !Number.isSafeInteger(document.generation)
    || (document.generation ?? 0) < 1
    || !Number.isSafeInteger(document.headSeq)
    || (document.headSeq ?? -1) < 0
    || !Number.isSafeInteger(document.projectedSeq)
    || (document.projectedSeq ?? -1) < 0
    || document.projectedSeq! > document.headSeq!
  ) {
    throw new Error("AI reference projection is corrupt");
  }
}
