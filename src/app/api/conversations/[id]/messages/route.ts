import { NextResponse } from "next/server";
import { z } from "zod";
import { appendConversationMessage, CONVERSATION_LIMITS } from "@/features/ai/conversation-repository";
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
const appendSchema = z.object({
  aiRunId: idSchema.nullish(),
  command: z.string().max(CONVERSATION_LIMITS.commandCharacters).nullish(),
  content: z.string().min(1).max(CONVERSATION_LIMITS.messageCharacters),
  expectedVersion: z.number().int().min(1),
  proposalId: idSchema.nullish(),
  role: z.enum(["assistant", "user"]),
  scopeLabel: z.string().max(CONVERSATION_LIMITS.scopeLabelCharacters).nullish(),
  status: z.enum(["failed", "idle"]),
}).strict().superRefine((value, context) => {
  if (value.proposalId && !value.aiRunId) {
    context.addIssue({
      code: "custom",
      message: "A proposal link requires its resolved AI run",
      path: ["aiRunId"],
    });
  }
});
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
  const parsed = appendSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const result = await appendConversationMessage(context, id.data, {
    ...parsed.data,
    aiRunId: parsed.data.aiRunId ?? null,
    command: parsed.data.command ?? null,
    mutationKey: key.data,
    proposalId: parsed.data.proposalId ?? null,
    scopeLabel: parsed.data.scopeLabel ?? null,
  });
  return conversationMutationResponse(result);
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "conversations.write") });

export async function POST(request: Request, context: RouteContext) {
  return postHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
