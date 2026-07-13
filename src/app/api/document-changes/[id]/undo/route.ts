import { NextResponse } from "next/server";
import { z } from "zod";
import { undoDocumentChange } from "@/features/documents/document-change-service";
import { documentChangeResponse, readDocumentChangeJson } from "@/features/documents/document-change-route";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";

const undoPayloadSchema = z.object({ expectedRevision: z.number().int().nonnegative() });
type UndoRouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (
  requestContext,
  request: Request,
  context: UndoRouteContext,
) => {
  const parsedRequest = await readDocumentChangeJson(request);
  if (!parsedRequest.ok) return parsedRequest.response;
  const result = undoPayloadSchema.safeParse(parsedRequest.payload);
  if (!result.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const { id: changeId } = await context.params;
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
