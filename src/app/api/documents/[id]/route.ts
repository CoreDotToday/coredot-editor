import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveDocument, getDocumentById, saveDocumentDraft } from "@/features/documents/document-repository";
import { documentReadinessValues } from "@/features/documents/document-metadata";
import { toPublicDocument } from "@/features/documents/document-public";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
  validateTiptapResource,
} from "@/features/security/resource-policy";

const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(500),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
  metadataJson: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
    .optional(),
  readiness: z.enum(documentReadinessValues).optional(),
  expectedRevision: z.number().int().nonnegative(),
});

type Params = {
  params: Promise<{ id: string }>;
};

const optionsHandler = createProtectedOptionsHandler(["GET", "PUT", "DELETE"]);
const getHandler = createProtectedRouteHandler(async (context, _request: Request, { params }: Params) => {
  const { id } = await params;
  const document = await getDocumentById(context, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ document: toPublicDocument(document) });
});

const putHandler = createProtectedRouteHandler(async (context, request: Request, { params }: Params) => {
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();
  const { id } = await params;
  let payload: unknown;
  try {
    payload = await parseBoundedJson(request);
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    payload = null;
  }
  const result = updateDocumentSchema.safeParse(payload);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!validateTiptapResource(result.data.contentJson).ok) return documentResourceLimitResponse();

  const body = result.data;
  const saveResult = await saveDocumentDraft(context, id, body);
  if (saveResult.status === "not_found") {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (saveResult.status === "revision_conflict") {
    return NextResponse.json(
      {
        error: "Document revision conflict",
        reason: "revision_conflict",
        document: toPublicDocument(saveResult.latest),
      },
      { status: 409 },
    );
  }
  if (saveResult.status === "invalid_profile") {
    return NextResponse.json({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: saveResult.violation,
    }, { status: 400 });
  }
  return NextResponse.json({ document: toPublicDocument(saveResult.document) });
});

const deleteHandler = createProtectedRouteHandler(async (context, _request: Request, { params }: Params) => {
  const { id } = await params;
  const document = await archiveDocument(context, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});

export async function GET(request: Request, params: Params) {
  return getHandler(request, params);
}

export async function PUT(request: Request, params: Params) {
  return putHandler(request, params);
}

export async function DELETE(request: Request, params: Params) {
  return deleteHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}
