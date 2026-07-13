import { NextResponse } from "next/server";
import { z } from "zod";
import { documentReadinessValues } from "./document-metadata";
import type { DocumentChangeIdentity, DocumentChangeResult } from "./document-change-service";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
  validateTiptapResource,
} from "@/features/security/resource-policy";

export const documentChangeDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
  metadataJson: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string()), z.null()]),
  ),
  readiness: z.enum(documentReadinessValues),
});

export async function readDocumentChangeJson(request: Request) {
  if (requestExceedsDocumentBodyLimit(request)) {
    return { ok: false as const, response: documentResourceLimitResponse() };
  }
  try {
    return { ok: true as const, payload: await parseBoundedJson(request) };
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    return {
      ok: false as const,
      response: resourceResponse ?? NextResponse.json({ error: "Invalid request body" }, { status: 400 }),
    };
  }
}

export function validateDocumentChangeDraftResource(contentJson: unknown) {
  return validateTiptapResource(contentJson).ok ? null : documentResourceLimitResponse();
}

export function documentChangeResponse(result: DocumentChangeResult, singleProposal = false) {
  if (result.ok) {
    return NextResponse.json({
      change: toDocumentChangeIdentity(result.change),
      document: result.document,
      ...(singleProposal ? { proposal: result.proposals[0] } : { proposals: result.proposals }),
    });
  }
  if (result.reason === "invalid_draft") return documentResourceLimitResponse();
  if (result.reason === "invalid_batch" || result.reason === "invalid_revision") {
    return NextResponse.json({ error: "Invalid request body", reason: result.reason }, { status: 400 });
  }
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "Document change resource not found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      document: result.document,
      error: "Document change conflict",
      ...(singleProposal ? { proposal: result.proposals?.[0] } : { proposals: result.proposals }),
      reason: result.applyFailureReason ?? result.reason,
    },
    { status: 409 },
  );
}

function toDocumentChangeIdentity(
  change: Extract<DocumentChangeResult, { ok: true }>["change"],
): DocumentChangeIdentity {
  return {
    afterRevision: change.afterRevision,
    batchId: change.batchId,
    createdAt: change.createdAt,
    documentId: change.documentId,
    id: change.id,
    kind: change.kind,
    undoneAt: change.undoneAt,
  };
}
