import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CONVERSATION_LIMITS,
  createConversation,
  listConversations,
} from "@/features/ai/conversation-repository";
import {
  CONVERSATION_REQUEST_BODY_BYTES,
  CONVERSATION_REQUEST_DEADLINE_MS,
  conversationFailureResponse,
  conversationMutationResponse,
  toPublicConversation,
} from "@/features/ai/conversation-http";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { parseBoundedJson, resourcePolicyErrorResponse } from "@/features/security/resource-policy";

const idSchema = z.string().min(1).max(128);
const keySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const futureDateSchema = z.string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value))
  .refine((value) => value.getTime() > Date.now());
const querySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: z.enum(["true", "false"]).transform((value) => value === "true").default(false),
  limit: z.coerce.number().int().min(1).max(CONVERSATION_LIMITS.maximumPageSize)
    .default(CONVERSATION_LIMITS.defaultPageSize),
}).strict();
const createSchema = z.object({
  command: z.string().min(1).max(CONVERSATION_LIMITS.commandCharacters),
  initialMessage: z.object({
    command: z.string().max(CONVERSATION_LIMITS.commandCharacters).optional(),
    content: z.string().min(1).max(CONVERSATION_LIMITS.messageCharacters),
    mutationKey: keySchema,
    role: z.literal("user"),
    scopeLabel: z.string().max(CONVERSATION_LIMITS.scopeLabelCharacters).optional(),
  }).strict(),
  retentionExpiresAt: futureDateSchema.nullable().optional(),
  title: z.string().trim().min(1).max(CONVERSATION_LIMITS.titleCharacters),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context, request: Request, routeContext: RouteContext) => {
  const parameters = await routeContext.params;
  const id = idSchema.safeParse(parameters.id);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!id.success || !query.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }
  const result = await listConversations(context, {
    cursor: query.data.cursor,
    documentId: id.data,
    includeArchived: query.data.includeArchived,
    limit: query.data.limit,
  });
  if (!result.ok) return conversationFailureResponse(result.reason);
  return NextResponse.json({
    conversations: result.value.items.map(toPublicConversation),
    nextCursor: result.value.nextCursor,
  });
});
const postHandler = createProtectedRouteHandler(async (context, request: Request, routeContext: RouteContext) => {
  const parameters = await routeContext.params;
  const id = idSchema.safeParse(parameters.id);
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
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const result = await createConversation(context, {
    ...parsed.data,
    creationKey: key.data,
    documentId: id.data,
  });
  return conversationMutationResponse(result, 201);
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "conversations.write") });

export async function GET(request: Request, context: RouteContext) {
  return getHandler(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return postHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
