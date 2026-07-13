import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CONVERSATION_LIMITS,
  archiveConversation,
  getConversationById,
  renameConversation,
  setConversationStatus,
} from "@/features/ai/conversation-repository";
import {
  CONVERSATION_REQUEST_BODY_BYTES,
  CONVERSATION_REQUEST_DEADLINE_MS,
  conversationMutationResponse,
  conversationFailureResponse,
  toPublicConversation,
} from "@/features/ai/conversation-http";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { parseBoundedJson, resourcePolicyErrorResponse } from "@/features/security/resource-policy";

const idSchema = z.string().min(1).max(128);
const expectedVersionSchema = z.number().int().min(1);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rename"),
    expectedVersion: expectedVersionSchema,
    title: z.string().trim().min(1).max(CONVERSATION_LIMITS.titleCharacters),
  }).strict(),
  z.object({
    action: z.literal("archive"),
    archived: z.boolean(),
    expectedVersion: expectedVersionSchema,
  }).strict(),
  z.object({
    action: z.literal("status"),
    expectedVersion: expectedVersionSchema,
    status: z.enum(["failed", "idle"]),
  }).strict(),
]);
type RouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["GET", "PATCH"]);
const getHandler = createProtectedRouteHandler(async (context, _request: Request, routeContext: RouteContext) => {
  const id = idSchema.safeParse((await routeContext.params).id);
  if (!id.success) return NextResponse.json({ error: "Invalid conversation request" }, { status: 400 });
  const result = await getConversationById(context, id.data);
  if (!result.ok) return conversationFailureResponse(result.reason);
  return NextResponse.json({ conversation: toPublicConversation(result.value) });
});
const patchHandler = createProtectedRouteHandler(async (context, request: Request, routeContext: RouteContext) => {
  const id = idSchema.safeParse((await routeContext.params).id);
  if (!id.success) return NextResponse.json({ error: "Invalid conversation request" }, { status: 400 });
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
  const parsed = mutationSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const result = parsed.data.action === "rename"
    ? await renameConversation(context, id.data, {
        expectedVersion: parsed.data.expectedVersion,
        title: parsed.data.title,
      })
    : parsed.data.action === "archive"
      ? await archiveConversation(context, id.data, {
          archived: parsed.data.archived,
          expectedVersion: parsed.data.expectedVersion,
        })
      : await setConversationStatus(context, id.data, {
          expectedVersion: parsed.data.expectedVersion,
          status: parsed.data.status,
        });
  return conversationMutationResponse(result);
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "conversations.write") });

export async function PATCH(request: Request, context: RouteContext) {
  return patchHandler(request, context);
}

export async function GET(request: Request, context: RouteContext) {
  return getHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
