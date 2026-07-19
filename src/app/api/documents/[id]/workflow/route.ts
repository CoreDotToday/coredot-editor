import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createProtectedOptionsHandler,
  createProtectedRouteHandler,
} from "@/features/auth/route-context";
import {
  DocumentWorkflowServiceError,
  executeDocumentWorkflowCommand,
  readDocumentWorkflowState,
  type DocumentWorkflowState,
} from "@/features/documents/document-workflow-service";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  parseBoundedJson,
  resourcePolicyErrorResponse,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const WORKFLOW_BODY_BYTES = 2_048;
const WORKFLOW_PARSE_DEADLINE_MS = 5_000;
const documentIdSchema = z.string().min(1).max(256);
const readinessSchema = z.enum(["draft", "needs_review", "ready", "approved"]);
const nonApprovalCommandSchema = z.object({
  expectedReadiness: readinessSchema,
  nextReadiness: z.enum(["draft", "needs_review", "ready"]),
}).strict();
const approvalCommandSchema = z.object({
  expectedReadiness: z.literal("ready"),
  nextReadiness: z.literal("approved"),
  observedHeadSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const workflowCommandSchema = z.union([nonApprovalCommandSchema, approvalCommandSchema]);

type Params = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context, _request: Request, route: Params) => {
  const documentId = await parseDocumentId(route);
  if (!documentId) return invalidRequestResponse();
  try {
    const workflow = await readDocumentWorkflowState(context, documentId);
    return workflowResponse(workflow);
  } catch (error) {
    return mapWorkflowError(error);
  }
});

const postHandler = createProtectedRouteHandler(async (context, request: Request, route: Params) => {
  const documentId = await parseDocumentId(route);
  if (!documentId) return invalidRequestResponse();
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > WORKFLOW_BODY_BYTES)
  ) {
    return NextResponse.json(
      { error: "Document workflow request is too large", reason: "resource_limit" },
      { status: 413 },
    );
  }
  let payload: unknown;
  try {
    payload = await parseBoundedJson(request, WORKFLOW_BODY_BYTES, {
      deadlineMs: WORKFLOW_PARSE_DEADLINE_MS,
      requestSignal: request.signal,
    });
  } catch (error) {
    return resourcePolicyErrorResponse(error) ?? invalidRequestResponse();
  }
  const command = workflowCommandSchema.safeParse(payload);
  if (!command.success) return invalidRequestResponse();
  try {
    const result = await executeDocumentWorkflowCommand(
      context,
      documentId,
      command.data,
    );
    return workflowResponse(result.workflow);
  } catch (error) {
    return mapWorkflowError(error);
  }
}, {
  beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.workflow"),
});

export async function GET(request: Request, params: Params) {
  return getHandler(request, params);
}

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}

async function parseDocumentId(route: Params) {
  const { id } = await route.params;
  const parsed = documentIdSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

function workflowResponse(workflow: DocumentWorkflowState) {
  return NextResponse.json({ workflow }, { headers: { "Cache-Control": "no-store" } });
}

function invalidRequestResponse() {
  return NextResponse.json(
    { error: "Invalid document workflow request", reason: "invalid_request" },
    { status: 400 },
  );
}

function mapWorkflowError(error: unknown) {
  if (!(error instanceof DocumentWorkflowServiceError)) throw error;
  const common = error.workflow ? { workflow: error.workflow } : {};
  switch (error.category) {
    case "expected_readiness_conflict":
      return NextResponse.json({
        error: "Document workflow state changed",
        reason: "expected_readiness_conflict",
        ...common,
      }, { status: 409 });
    case "head_conflict":
      return NextResponse.json({
        error: "Document collaboration state changed",
        reason: "head_conflict",
        ...common,
      }, { status: 409 });
    case "legacy_approval_unsupported":
      return NextResponse.json({
        error: "Legacy approval requires collaboration initialization",
        reason: "legacy_approval_unsupported",
        ...common,
      }, { status: 409 });
    case "invalid_project_profile":
      return NextResponse.json({
        error: "Document violates active Project Profile",
        reason: "invalid_project_profile",
        ...(error.violation ? { violation: error.violation } : {}),
        ...common,
      }, { status: 400 });
    case "forbidden":
      return NextResponse.json({ error: "Forbidden", reason: "forbidden" }, { status: 403 });
    case "not_found":
      return NextResponse.json({ error: "Document not found", reason: "not_found" }, { status: 404 });
    case "invalid_request":
      return invalidRequestResponse();
    case "unavailable":
      return NextResponse.json(
        { error: "Document workflow unavailable", reason: "workflow_unavailable" },
        { headers: { "Retry-After": "1" }, status: 503 },
      );
  }
}
