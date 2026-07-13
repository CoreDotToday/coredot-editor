import { NextResponse } from "next/server";
import { z } from "zod";
import { CONVERSATION_LIMITS, forkConversation } from "@/features/ai/conversation-repository";
import {
  CONVERSATION_REQUEST_BODY_BYTES,
  CONVERSATION_REQUEST_DEADLINE_MS,
  conversationMutationResponse,
} from "@/features/ai/conversation-http";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { parseBoundedJson, resourcePolicyErrorResponse } from "@/features/security/resource-policy";

const idSchema = z.string().min(1).max(128);
const keySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const forkSchema = z.object({
  throughMessageId: idSchema,
  title: z.string().trim().min(1).max(CONVERSATION_LIMITS.titleCharacters),
}).strict();
type RouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context, request: Request, routeContext: RouteContext) => {
  const id = idSchema.safeParse((await routeContext.params).id);
  const key = keySchema.safeParse(request.headers.get("Idempotency-Key"));
  if (!id.success || !key.success) {
    return NextResponse.json({ error: "Invalid conversation request" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await parseBoundedJson(request, CONVERSATION_REQUEST_BODY_BYTES, {
      deadlineMs: CONVERSATION_REQUEST_DEADLINE_MS,
      requestSignal: request.signal,
    });
  } catch (error) {
    const response = resourcePolicyErrorResponse(error);
    if (response) return response;
    payload = null;
  }
  const parsed = forkSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const result = await forkConversation(context, id.data, { ...parsed.data, creationKey: key.data });
  return conversationMutationResponse(result, 201);
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "conversations.fork") });

export async function POST(request: Request, context: RouteContext) {
  return postHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
