import { NextResponse } from "next/server";
import { z } from "zod";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import {
  loadExactCollaborationMaterialization,
  toExactCollaborationHttpFailure,
} from "@/features/collaboration/exact-document-materialization";
import { documentInterchange } from "@/features/documents/document-interchange";
import { getDocumentById } from "@/features/documents/document-repository";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  RESOURCE_LIMITS,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const previewExportSchema = z.object({
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
});

type Params = {
  params: Promise<{ id: string }>;
};

const postHandler = createProtectedRouteHandler(async (context, request: Request, { params }: Params) => {
  const deadline = Date.now() + RESOURCE_LIMITS.operationMs;
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();

  const { id } = await params;
  const document = await getDocumentById(context, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await parseBoundedJson(request, undefined, {
      deadlineMs: remainingDeadlineMs(deadline),
      requestSignal: request.signal,
    });
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    payload = null;
  }
  const result = previewExportSchema.safeParse(payload);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let exactMaterialization: Awaited<ReturnType<typeof loadExactCollaborationMaterialization>>;
  try {
    exactMaterialization = await loadExactCollaborationMaterialization(context, id);
  } catch (error) {
    const failure = toExactCollaborationHttpFailure(error);
    if (failure) {
      return NextResponse.json({ code: failure.code, error: failure.error }, { status: failure.status });
    }
    throw error;
  }
  const contentJson = exactMaterialization.kind === "collaboration"
    ? exactMaterialization.materialization.contentJson
    : result.data.contentJson;
  const preview = await documentInterchange.previewExport(contentJson);
  if (!preview.ok) return documentResourceLimitResponse();
  return NextResponse.json({
    ...(exactMaterialization.kind === "collaboration"
      ? { collaboration: exactMaterialization.diagnostics }
      : {}),
    fidelity: preview.fidelity,
  });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.export-preview") });

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}

function remainingDeadlineMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}
