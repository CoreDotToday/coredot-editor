import { NextResponse } from "next/server";
import type { Conversation, ConversationFailureReason, ConversationResult } from "./conversation-repository";

export const CONVERSATION_REQUEST_BODY_BYTES = 640 * 1024;
export const CONVERSATION_REQUEST_DEADLINE_MS = 5_000;

export function toPublicConversation(conversation: Conversation) {
  return {
    ...conversation,
    createdAt: conversation.createdAt.toISOString(),
    messages: conversation.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
    retentionExpiresAt: conversation.retentionExpiresAt?.toISOString() ?? null,
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function conversationFailureResponse(reason: ConversationFailureReason) {
  if (reason === "not_found") {
    return NextResponse.json({ error: "Conversation resource not found" }, { status: 404 });
  }
  if (reason === "conflict" || reason === "limit") {
    return NextResponse.json(
      { error: reason === "limit" ? "Conversation limit reached" : "Conversation update conflict", reason },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: "Invalid conversation operation" }, { status: 400 });
}

export function conversationMutationResponse(
  result: ConversationResult<Conversation>,
  createdStatus = 200,
) {
  if (!result.ok) return conversationFailureResponse(result.reason);
  return NextResponse.json(
    { conversation: toPublicConversation(result.value), replayed: result.replayed === true },
    { status: result.replayed ? 200 : createdStatus },
  );
}
