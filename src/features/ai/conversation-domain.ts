export const CONVERSATION_LIMITS = Object.freeze({
  charactersPerConversation: 1_000_000,
  commandCharacters: 200,
  conversationsPerDocument: 100,
  defaultPageSize: 20,
  maximumPageSize: 50,
  messageCharacters: 100_000,
  messagesPerConversation: 100,
  scopeLabelCharacters: 120,
  titleCharacters: 120,
});

export type ConversationStatus = "failed" | "idle";

export type ConversationMessage = {
  aiRunId: string | null;
  command: string | null;
  content: string;
  createdAt: Date;
  id: string;
  proposalId: string | null;
  role: "assistant" | "user";
  scopeLabel: string | null;
};

export type Conversation = {
  archived: boolean;
  command: string;
  createdAt: Date;
  documentId: string;
  id: string;
  latestAiRunId: string | null;
  latestProposalId: string | null;
  messageCount: number;
  messages: ConversationMessage[];
  retentionExpiresAt: Date | null;
  status: ConversationStatus;
  title: string;
  updatedAt: Date;
  version: number;
};

export type ConversationFailureReason = "conflict" | "invalid" | "limit" | "not_found";
export type ConversationResult<T> =
  | { ok: false; reason: ConversationFailureReason }
  | { ok: true; replayed?: boolean; value: T };

export type CreateConversationInput = {
  command: string;
  creationKey: string;
  documentId: string;
  initialMessage: {
    command?: string | null;
    content: string;
    mutationKey: string;
    role: "user";
    scopeLabel?: string | null;
  };
  retentionExpiresAt?: Date | null;
  title: string;
};

export type AppendConversationInput = {
  aiRunId?: string | null;
  command?: string | null;
  content: string;
  expectedVersion: number;
  mutationKey: string;
  proposalId?: string | null;
  role: "assistant" | "user";
  scopeLabel?: string | null;
  status: ConversationStatus;
};

export type ConversationPage = { items: Conversation[]; nextCursor: string | null };

export function isValidCreateInput(input: CreateConversationInput) {
  return isValidKey(input.creationKey) &&
    input.documentId.length > 0 &&
    input.title.trim().length > 0 &&
    input.title.trim().length <= CONVERSATION_LIMITS.titleCharacters &&
    input.command.length > 0 &&
    input.command.length <= CONVERSATION_LIMITS.commandCharacters &&
    isValidKey(input.initialMessage.mutationKey) &&
    input.initialMessage.content.length > 0 &&
    input.initialMessage.content.length <= CONVERSATION_LIMITS.messageCharacters &&
    (input.initialMessage.scopeLabel?.length ?? 0) <= CONVERSATION_LIMITS.scopeLabelCharacters &&
    (!input.retentionExpiresAt || input.retentionExpiresAt.getTime() > Date.now());
}

export function isValidAppendInput(input: AppendConversationInput) {
  return isExpectedVersion(input.expectedVersion) &&
    isValidKey(input.mutationKey) &&
    input.content.length > 0 &&
    input.content.length <= CONVERSATION_LIMITS.messageCharacters &&
    (!input.proposalId || Boolean(input.aiRunId)) &&
    (input.command?.length ?? 0) <= CONVERSATION_LIMITS.commandCharacters &&
    (input.scopeLabel?.length ?? 0) <= CONVERSATION_LIMITS.scopeLabelCharacters &&
    (input.status === "failed" || input.status === "idle");
}

export function isExpectedVersion(value: number) {
  return Number.isSafeInteger(value) && value >= 1;
}

export function isValidKey(value: string) {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function encodeConversationCursor(updatedAt: Date, id: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ id, updatedAt: updatedAt.getTime() }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function decodeConversationCursor(value: string): { id: string; updatedAt: Date } | null {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as { id?: unknown; updatedAt?: unknown };
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length < 1 ||
      candidate.id.length > 256 ||
      !Number.isSafeInteger(candidate.updatedAt)
    ) return null;
    const updatedAt = new Date(Number(candidate.updatedAt));
    return Number.isFinite(updatedAt.getTime()) ? { id: candidate.id, updatedAt } : null;
  } catch {
    return null;
  }
}
