import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createProtectedOptionsHandler,
  createProtectedRouteHandler,
} from "@/features/auth/route-context";
import {
  CollaborationCapabilityServiceError,
  issueCollaborationCapabilityForDocument,
} from "@/features/collaboration/capability-service";
import { enforceRequestBudget } from "@/features/security/request-budget";

export const runtime = "nodejs";

const documentIdSchema = z.string().min(1).max(256);
type Params = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context, request: Request, route: Params) => {
  const { id: rawDocumentId } = await route.params;
  const documentId = documentIdSchema.safeParse(rawDocumentId);
  if (!documentId.success || hasNonemptyBody(request)) {
    return NextResponse.json(
      { error: "Invalid collaboration capability request" },
      { status: 400 },
    );
  }
  try {
    const capability = await issueCollaborationCapabilityForDocument(context, {
      documentId: documentId.data,
    });
    return NextResponse.json(capability, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (!(error instanceof CollaborationCapabilityServiceError)) throw error;
    if (error.category === "not_found") {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    if (error.category === "invalid_request") {
      return NextResponse.json(
        { error: "Invalid collaboration capability request" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Collaboration capability unavailable" },
      { headers: { "Retry-After": "1" }, status: 503 },
    );
  }
}, {
  beforeWorkspaceBootstrap: (context) => enforceRequestBudget(
    context,
    "collaboration.capability",
  ),
});

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}

function hasNonemptyBody(request: Request) {
  // Real HTTP requests reach this handler with an empty body stream rather
  // than a null body, so emptiness is decided from the declared length first.
  // A chunked request hides its length and is rejected outright; a body
  // stream without any declared length is treated as nonempty.
  if (request.headers.get("transfer-encoding") !== null) return true;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) return !/^0+$/.test(contentLength);
  return request.body !== null;
}
