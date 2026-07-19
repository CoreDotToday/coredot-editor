import { NextResponse } from "next/server";
import { z } from "zod";
import { applyProposalBatch } from "@/features/documents/document-change-service";
import {
  documentChangeDraftSchema,
  documentChangeResponse,
  readDocumentChangeJson,
  validateDocumentChangeDraftResource,
} from "@/features/documents/document-change-route";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";

const proposalBatchApplyPayloadSchema = z.object({
  document: documentChangeDraftSchema,
  expectedRevision: z.number().int().nonnegative(),
  proposals: z.array(z.object({
    id: z.string().min(1),
    appliedMode: z.enum(["replace", "insert_below"]),
  }).strict()).min(1),
}).strict();

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (requestContext, request: Request) => {
  const parsedRequest = await readDocumentChangeJson(request);
  if (!parsedRequest.ok) return parsedRequest.response;
  const result = proposalBatchApplyPayloadSchema.safeParse(parsedRequest.payload);
  if (!result.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  if (result.data.proposals.length > RESOURCE_LIMITS.proposalBatchItems) {
    return NextResponse.json({ error: "Proposal batch exceeds resource limits" }, { status: 413 });
  }
  if (new Set(result.data.proposals.map(({ id }) => id)).size !== result.data.proposals.length) {
    return NextResponse.json({ error: "Duplicate proposal ids" }, { status: 400 });
  }
  const resourceResponse = validateDocumentChangeDraftResource(result.data.document.contentJson);
  if (resourceResponse) return resourceResponse;

  return documentChangeResponse(await applyProposalBatch(requestContext, {
    documentId: result.data.document.id,
    draft: {
      title: result.data.document.title,
      contentJson: result.data.document.contentJson,
      metadataJson: result.data.document.metadataJson,
    },
    expectedRevision: result.data.expectedRevision,
    proposals: result.data.proposals.map((proposal) => ({
      proposalId: proposal.id,
      mode: proposal.appliedMode,
    })),
  }));
});

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}
