import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadExactCollaborationMaterialization,
  toExactCollaborationHttpFailure,
  type ExactCollaborationDiagnostics,
} from "@/features/collaboration/exact-document-materialization";
import { getDocumentById } from "@/features/documents/document-repository";
import { documentInterchange } from "@/features/documents/document-interchange";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  RESOURCE_LIMITS,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const optionsHandler = createProtectedOptionsHandler(["POST"]);

const exportDocumentSchema = z.object({
  acknowledgedLoss: z.boolean().optional(),
  title: z.string().trim().min(1).max(500),
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
  const result = exportDocumentSchema.safeParse(payload);
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
  const exportInput = exactMaterialization.kind === "collaboration"
    ? {
        acknowledgedLoss: result.data.acknowledgedLoss,
        contentJson: exactMaterialization.materialization.contentJson,
        title: exactMaterialization.materialization.title,
      }
    : result.data;

  let exportResult: Awaited<ReturnType<typeof documentInterchange.export>>;
  try {
    exportResult = await documentInterchange.export({
      ...exportInput,
      signal: request.signal,
      timeoutMs: remainingDeadlineMs(deadline),
    });
  } catch (error) {
    return resourcePolicyErrorResponse(error) ?? NextResponse.json({ error: "DOCX export failed" }, { status: 500 });
  }
  if (!exportResult.ok) {
    if (exportResult.reason === "resource_limit") return documentResourceLimitResponse();
    return NextResponse.json({
      code: "fidelity_acknowledgement_required",
      ...(exactMaterialization.kind === "collaboration"
        ? { collaboration: exactMaterialization.diagnostics }
        : {}),
      error: "Export requires loss acknowledgement",
      fidelity: exportResult.fidelity,
    }, { status: 409 });
  }
  return new Response(new Uint8Array(exportResult.buffer), {
    headers: {
      "Content-Disposition": `attachment; filename="${sanitizeFileName(exportInput.title)}.docx"`,
      "Content-Type": DOCX_MIME_TYPE,
      ...(exactMaterialization.kind === "collaboration"
        ? collaborationDiagnosticHeaders(exactMaterialization.diagnostics)
        : {}),
    },
  });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.export") });

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "document";
}

function remainingDeadlineMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

function collaborationDiagnosticHeaders(diagnostics: ExactCollaborationDiagnostics) {
  return {
    "X-CoreDot-Collaboration-Content-Hash": diagnostics.contentHash,
    "X-CoreDot-Collaboration-Generation": String(diagnostics.generation),
    "X-CoreDot-Collaboration-Head-Seq": String(diagnostics.headSeq),
    "X-CoreDot-Collaboration-Schema-Fingerprint": diagnostics.schemaFingerprint,
  };
}
