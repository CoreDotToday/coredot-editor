import { NextResponse } from "next/server";
import { z } from "zod";
import {
  undoCollaborativeDocumentChange,
  type CollaborativeUndoResult,
} from "@/features/collaboration/selective-undo";
import { undoDocumentChange } from "@/features/documents/document-change-service";
import { documentChangeResponse, readDocumentChangeJson } from "@/features/documents/document-change-route";
import { toPublicDocument } from "@/features/documents/document-public";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";

const undoPayloadSchema = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
const collaborativeUndoPayloadSchema = z.object({
  commandId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  observedHeadSeq: z.number().int().nonnegative(),
}).strict();
type UndoRouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (
  requestContext,
  request: Request,
  context: UndoRouteContext,
) => {
  const parsedRequest = await readDocumentChangeJson(request);
  if (!parsedRequest.ok) return parsedRequest.response;
  const { id: changeId } = await context.params;
  const collaborative = collaborativeUndoPayloadSchema.safeParse(parsedRequest.payload);
  if (collaborative.success) {
    return collaborativeUndoResponse(await undoCollaborativeDocumentChange(requestContext, {
      changeId,
      commandId: collaborative.data.commandId,
      observedHeadSeq: collaborative.data.observedHeadSeq,
    }));
  }
  const result = undoPayloadSchema.safeParse(parsedRequest.payload);
  if (!result.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  return documentChangeResponse(await undoDocumentChange(requestContext, {
    changeId,
    expectedRevision: result.data.expectedRevision,
  }));
});

export async function POST(request: Request, context: UndoRouteContext) {
  return postHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}

function collaborativeUndoResponse(result: CollaborativeUndoResult) {
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
    return NextResponse.json({ error: "Document change resource not found", reason: result.reason }, { status: 404 });
  }
  if (result.reason === "unavailable") {
    return NextResponse.json({ error: "Collaboration command unavailable", reason: result.reason }, { status: 503 });
  }
  return NextResponse.json({ error: "Document change undo conflict", reason: result.reason }, { status: 409 });
}
