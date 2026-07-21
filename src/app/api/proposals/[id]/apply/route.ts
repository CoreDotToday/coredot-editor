import { NextResponse } from "next/server";
import { z } from "zod";
import { applyProposal } from "@/features/documents/document-change-service";
import { toPublicDocument } from "@/features/documents/document-public";
import {
  applyCollaborativeProposalCommand,
  type CollaborativeProposalApplyResult,
} from "@/features/collaboration/proposal-command-service";
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

const collaborativeProposalApplyPayloadSchema = z.object({
  commandId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  mode: z.enum(["replace", "insert_below"]),
  observedHeadSeq: z.number().int().nonnegative(),
  proposalId: z.string().min(1).max(256),
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
  const { id: proposalId } = await context.params;
  const collaborative = collaborativeProposalApplyPayloadSchema.safeParse(parsedRequest.payload);
  if (collaborative.success) {
    if (collaborative.data.proposalId !== proposalId) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    return collaborativeProposalResponse(await applyCollaborativeProposalCommand(requestContext, {
      commandId: collaborative.data.commandId,
      items: [{ mode: collaborative.data.mode, proposalId }],
      observedHeadSeq: collaborative.data.observedHeadSeq,
    }), true);
  }

  const result = proposalApplyPayloadSchema.safeParse(parsedRequest.payload);
  if (!result.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const resourceResponse = validateDocumentChangeDraftResource(result.data.document.contentJson);
  if (resourceResponse) return resourceResponse;

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

function collaborativeProposalResponse(
  result: CollaborativeProposalApplyResult,
  single: boolean,
) {
  if (result.ok) {
    const change = {
      afterRevision: result.change.afterRevision,
      batchId: result.change.batchId,
      createdAt: result.change.createdAt,
      documentId: result.change.documentId,
      id: result.change.id,
      kind: result.change.kind,
      undoneAt: result.change.undoneAt,
    };
    return NextResponse.json({
      change,
      collaboration: result.collaboration,
      document: toPublicDocument(result.document),
      ...(single ? { proposal: result.proposals[0] } : { proposals: result.proposals }),
      replayed: result.replayed,
    });
  }
  if (result.reason === "invalid_request") {
    return NextResponse.json({ error: "Invalid request body", reason: result.reason }, { status: 400 });
  }
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "Proposal not found", reason: result.reason }, { status: 404 });
  }
  if (result.reason === "unavailable") {
    return NextResponse.json({ error: "Collaboration command unavailable", reason: result.reason }, { status: 503 });
  }
  return NextResponse.json({ error: "Proposal command conflict", reason: result.reason }, { status: 409 });
}
