import { NextResponse } from "next/server";
import { z } from "zod";
import { applyProposal } from "@/features/documents/document-change-service";
import {
  documentChangeDraftSchema,
  documentChangeResponse,
  readDocumentChangeJson,
  validateDocumentChangeDraftResource,
} from "@/features/documents/document-change-route";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";

const proposalApplyPayloadSchema = z.object({
  appliedMode: z.enum(["replace", "insert_below"]),
  document: documentChangeDraftSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict();

type ProposalApplyRouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (
  requestContext,
  request: Request,
  context: ProposalApplyRouteContext,
) => {
  const parsedRequest = await readDocumentChangeJson(request);
  if (!parsedRequest.ok) return parsedRequest.response;
  const result = proposalApplyPayloadSchema.safeParse(parsedRequest.payload);
  if (!result.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const resourceResponse = validateDocumentChangeDraftResource(result.data.document.contentJson);
  if (resourceResponse) return resourceResponse;

  const { id: proposalId } = await context.params;
  return documentChangeResponse(await applyProposal(requestContext, {
    documentId: result.data.document.id,
    draft: {
      title: result.data.document.title,
      contentJson: result.data.document.contentJson,
      metadataJson: result.data.document.metadataJson,
    },
    expectedRevision: result.data.expectedRevision,
    mode: result.data.appliedMode,
    proposalId,
  }), true);
});

export async function POST(request: Request, context: ProposalApplyRouteContext) {
  return postHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
