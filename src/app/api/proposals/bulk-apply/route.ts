import { NextResponse } from "next/server";
import { z } from "zod";
import { applyProposalBatch } from "@/features/documents/document-change-service";
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
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";

const proposalBatchApplyPayloadSchema = z.object({
  document: documentChangeDraftSchema,
  expectedRevision: z.number().int().nonnegative(),
  proposals: z.array(z.object({
    id: z.string().min(1),
    appliedMode: z.enum(["replace", "insert_below"]),
  }).strict()).min(1),
}).strict();

const collaborativeProposalBatchApplyPayloadSchema = z.object({
  commandId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  items: z.array(z.object({
    mode: z.enum(["replace", "insert_below"]),
    proposalId: z.string().min(1).max(256),
  }).strict()).min(1),
  observedHeadSeq: z.number().int().nonnegative(),
}).strict();

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (requestContext, request: Request) => {
  const parsedRequest = await readDocumentChangeJson(request);
  if (!parsedRequest.ok) return parsedRequest.response;
  const collaborative = collaborativeProposalBatchApplyPayloadSchema.safeParse(parsedRequest.payload);
  if (collaborative.success) {
    if (collaborative.data.items.length > RESOURCE_LIMITS.proposalBatchItems) {
      return NextResponse.json({ error: "Proposal batch exceeds resource limits" }, { status: 413 });
    }
    if (new Set(collaborative.data.items.map(({ proposalId }) => proposalId)).size
      !== collaborative.data.items.length) {
      return NextResponse.json({ error: "Duplicate proposal ids" }, { status: 400 });
    }
    return collaborativeProposalResponse(await applyCollaborativeProposalCommand(requestContext, {
      commandId: collaborative.data.commandId,
      items: collaborative.data.items,
      observedHeadSeq: collaborative.data.observedHeadSeq,
    }));
  }
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

function collaborativeProposalResponse(result: CollaborativeProposalApplyResult) {
  if (result.ok) {
    return NextResponse.json({
      change: {
        afterRevision: result.change.afterRevision,
        batchId: result.change.batchId,
        createdAt: result.change.createdAt,
        documentId: result.change.documentId,
        id: result.change.id,
        kind: result.change.kind,
        undoneAt: result.change.undoneAt,
      },
      collaboration: result.collaboration,
      document: toPublicDocument(result.document),
      proposals: result.proposals,
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
