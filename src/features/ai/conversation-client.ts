import { z } from "zod";
import {
  isValidAppendInput,
  type AppendConversationInput,
  type Conversation,
  type CreateConversationInput,
} from "./conversation-domain";
import type {
  ConversationStore,
  StoreResult,
  StoredConversationView,
} from "./conversation-store";

type RequestFunction = (input: string, init?: RequestInit) => Promise<Response>;

const dateSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const nullableIdSchema = z.string().min(1).nullable();
const messageSchema = z.object({
  aiRunId: nullableIdSchema,
  command: z.string().nullable(),
  content: z.string(),
  createdAt: dateSchema,
  id: z.string().min(1),
  proposalId: nullableIdSchema,
  role: z.enum(["assistant", "user"]),
  scopeLabel: z.string().nullable(),
}).strict();
const conversationSummarySchema = z.object({
  archived: z.boolean(),
  command: z.string(),
  createdAt: dateSchema,
  documentId: z.string().min(1),
  id: z.string().min(1),
  latestAiRunId: nullableIdSchema,
  latestProposalId: nullableIdSchema,
  messageCount: z.number().int().nonnegative(),
  retentionExpiresAt: dateSchema.nullable(),
  status: z.enum(["failed", "idle"]),
  title: z.string(),
  updatedAt: dateSchema,
  version: z.number().int().positive(),
}).strict();
const conversationSchema = conversationSummarySchema.extend({
  messages: z.array(messageSchema),
}).strict().refine((value) => value.messageCount === value.messages.length);
const mutationResponseSchema = z.object({
  conversation: conversationSchema,
  replayed: z.boolean(),
}).strict();
const listResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();
const detailResponseSchema = z.object({ conversation: conversationSchema }).strict();

export function createHttpConversationStore(
  request: RequestFunction = (input, init) => fetch(input, init),
): ConversationStore {
  async function mutate(
    path: string,
    init: RequestInit,
  ): Promise<StoreResult<StoredConversationView>> {
    const response = await safelyRequest(request, path, init);
    if (!response) return { ok: false, reason: "unavailable" };
    if (!response.ok) return failureFromResponse(response);
    const payload = await safelyReadJson(response);
    const parsed = mutationResponseSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: "unavailable" };
    return {
      ok: true,
      replayed: parsed.data.replayed,
      value: parseConversation(parsed.data.conversation),
    };
  }

  return {
    async get(_documentId, conversationId) {
      const response = await safelyRequest(
        request,
        `/api/conversations/${encodeURIComponent(conversationId)}`,
        { method: "GET" },
      );
      if (!response) return { ok: false, reason: "unavailable" };
      if (!response.ok) return failureFromResponse(response);
      const parsed = detailResponseSchema.safeParse(await safelyReadJson(response));
      return parsed.success
        ? { ok: true, value: parseConversation(parsed.data.conversation) }
        : { ok: false, reason: "unavailable" };
    },

    async list(input) {
      const search = new URLSearchParams();
      if (input.cursor) search.set("cursor", input.cursor);
      if (input.includeArchived !== undefined) search.set("includeArchived", String(input.includeArchived));
      if (input.limit !== undefined) search.set("limit", String(input.limit));
      const query = search.size > 0 ? `?${search.toString()}` : "";
      const response = await safelyRequest(
        request,
        `/api/documents/${encodeURIComponent(input.documentId)}/conversations${query}`,
        { method: "GET" },
      );
      if (!response) return { ok: false, reason: "unavailable" };
      if (!response.ok) return failureFromResponse(response);
      const payload = await safelyReadJson(response);
      const parsed = listResponseSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, reason: "unavailable" };
      return {
        ok: true,
        value: {
          items: parsed.data.conversations.map(parseConversationSummary),
          nextCursor: parsed.data.nextCursor,
        },
      };
    },

    create(input: CreateConversationInput) {
      const { creationKey, documentId, ...body } = input;
      return mutate(`/api/documents/${encodeURIComponent(documentId)}/conversations`, {
        body: JSON.stringify({
          ...body,
          retentionExpiresAt: body.retentionExpiresAt?.toISOString(),
        }),
        headers: jsonHeaders(creationKey),
        method: "POST",
      });
    },

    async append(documentId: string, conversationId: string, input: AppendConversationInput) {
      if (!isValidAppendInput(input)) return { ok: false, reason: "invalid" } as const;
      const { mutationKey, ...body } = input;
      return mutate(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        body: JSON.stringify(body),
        headers: jsonHeaders(mutationKey),
        method: "POST",
      });
    },

    rename(_documentId, conversationId, input) {
      return mutate(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        body: JSON.stringify({ action: "rename", ...input }),
        headers: jsonHeaders(),
        method: "PATCH",
      });
    },

    archive(_documentId, conversationId, input) {
      return mutate(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        body: JSON.stringify({ action: "archive", ...input }),
        headers: jsonHeaders(),
        method: "PATCH",
      });
    },

    setStatus(_documentId, conversationId, input) {
      return mutate(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        body: JSON.stringify({ action: "status", ...input }),
        headers: jsonHeaders(),
        method: "PATCH",
      });
    },

    fork(_documentId, conversationId, input) {
      const { creationKey, ...body } = input;
      return mutate(`/api/conversations/${encodeURIComponent(conversationId)}/fork`, {
        body: JSON.stringify(body),
        headers: jsonHeaders(creationKey),
        method: "POST",
      });
    },
  };
}

function parseConversationSummary(value: z.infer<typeof conversationSummarySchema>) {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    retentionExpiresAt: value.retentionExpiresAt ? new Date(value.retentionExpiresAt) : null,
    syncStatus: "saved" as const,
    updatedAt: new Date(value.updatedAt),
  };
}

function parseConversation(value: z.infer<typeof conversationSchema>): StoredConversationView {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    messages: value.messages.map((message) => ({ ...message, createdAt: new Date(message.createdAt) })),
    retentionExpiresAt: value.retentionExpiresAt ? new Date(value.retentionExpiresAt) : null,
    syncStatus: "saved",
    updatedAt: new Date(value.updatedAt),
  } satisfies Conversation & { syncStatus: "saved" };
}

function jsonHeaders(idempotencyKey?: string) {
  return {
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

async function safelyRequest(request: RequestFunction, path: string, init: RequestInit) {
  try {
    return await request(path, init);
  } catch {
    return null;
  }
}

async function safelyReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failureFromResponse(response: Response): Promise<StoreResult<never>> {
  if (response.status === 404) return { ok: false, reason: "not_found" };
  if (response.status === 400) return { ok: false, reason: "invalid" };
  if (response.status === 409) {
    const parsed = z.object({ reason: z.enum(["conflict", "limit"]) }).passthrough()
      .safeParse(await safelyReadJson(response));
    return { ok: false, reason: parsed.success ? parsed.data.reason : "conflict" };
  }
  return { ok: false, reason: "unavailable" };
}
