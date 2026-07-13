import { beforeEach, describe, expect, it, vi } from "vitest";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { createConversation, listConversations } from "@/features/ai/conversation-repository";
import { InvalidCollectionCursorError } from "@/features/pagination/collection-cursor";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET, OPTIONS, POST } from "./route";

vi.mock("@/features/ai/conversation-repository", () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  CONVERSATION_LIMITS: {
    commandCharacters: 200,
    defaultPageSize: 20,
    maximumPageSize: 50,
    messageCharacters: 100_000,
    scopeLabelCharacters: 120,
    titleCharacters: 120,
  },
}));
vi.mock("@/features/security/request-budget", () => ({
  enforceRequestBudget: vi.fn(async () => null),
}));

const conversation = {
  archived: false,
  command: "Rewrite",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  documentId: "doc-a",
  id: "conversation-a",
  latestAiRunId: null,
  latestProposalId: null,
  messageCount: 1,
  messages: [{
    aiRunId: null,
    command: "Rewrite",
    content: "Original",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    id: "message-a",
    proposalId: null,
    role: "user" as const,
    scopeLabel: null,
  }],
  retentionExpiresAt: null,
  status: "idle" as const,
  title: "Rewrite",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  version: 1,
};

describe("document conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("lists a bounded Workspace-scoped page", async () => {
    const { messages: _messages, ...summary } = conversation;
    void _messages;
    vi.mocked(listConversations).mockResolvedValueOnce({
      ok: true,
      value: { items: [summary], nextCursor: "next" },
    });
    const response = await GET(
      new Request("http://localhost/api/documents/doc-a/conversations?limit=10&includeArchived=true"),
      { params: Promise.resolve({ id: "doc-a" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ conversations: [{ id: "conversation-a" }], nextCursor: "next" });
    expect(body.conversations[0]).not.toHaveProperty("messages");
    expect(listConversations).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      cursor: undefined,
      documentId: "doc-a",
      includeArchived: true,
      limit: 10,
    });
  });

  it("returns 400 for a cursor replayed outside its original list scope", async () => {
    vi.mocked(listConversations).mockRejectedValueOnce(new InvalidCollectionCursorError());

    const response = await GET(
      new Request("http://localhost/api/documents/doc-b/conversations?cursor=wrong-scope"),
      { params: Promise.resolve({ id: "doc-b" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid collection cursor" });
  });

  it("creates a conversation with bounded JSON and a required idempotency key", async () => {
    vi.mocked(createConversation).mockResolvedValueOnce({ ok: true, replayed: false, value: conversation });
    const response = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "conversation-create-0001" },
      body: JSON.stringify({
        command: "Rewrite",
        retentionExpiresAt: "2099-01-01T00:00:00.000Z",
        title: "Rewrite",
        initialMessage: {
          content: "Original",
          command: "Rewrite",
          mutationKey: "conversation-message-0001",
          role: "user",
        },
      }),
    }), { params: Promise.resolve({ id: "doc-a" }) });

    expect(response.status).toBe(201);
    expect(createConversation).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, expect.objectContaining({
      creationKey: "conversation-create-0001",
      documentId: "doc-a",
      retentionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }));
  });

  it("accepts the full AI selection size within a bounded UTF-8 body and rejects one extra character", async () => {
    vi.mocked(createConversation).mockResolvedValue({ ok: true, replayed: false, value: conversation });
    const content = "가".repeat(100_000);
    const accepted = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "large-conversation-key-0001" },
      body: JSON.stringify({
        command: "Rewrite",
        initialMessage: { content, mutationKey: "large-message-key-0001", role: "user" },
        title: "Large selection",
      }),
    }), { params: Promise.resolve({ id: "doc-a" }) });
    expect(accepted.status).toBe(201);
    expect(createConversation).toHaveBeenLastCalledWith(TEST_REQUEST_CONTEXT, expect.objectContaining({
      initialMessage: expect.objectContaining({ content }),
    }));

    const rejected = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "large-conversation-key-0002" },
      body: JSON.stringify({
        command: "Rewrite",
        initialMessage: { content: `${content}x`, mutationKey: "large-message-key-0002", role: "user" },
        title: "Too large",
      }),
    }), { params: Promise.resolve({ id: "doc-a" }) });
    expect(rejected.status).toBe(400);
  });

  it("rejects missing keys, unknown fields, oversized bodies, and scoped not-found uniformly", async () => {
    const missingKey = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      body: JSON.stringify({ command: "Rewrite", title: "Rewrite", initialMessage: {} }),
    }), { params: Promise.resolve({ id: "doc-a" }) });
    expect(missingKey.status).toBe(400);

    const unknown = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": "conversation-create-0001" },
      body: JSON.stringify({ command: "Rewrite", title: "Rewrite", initialMessage: { content: "x", mutationKey: "message-create-0001", role: "user" }, extra: true }),
    }), { params: Promise.resolve({ id: "doc-a" }) });
    expect(unknown.status).toBe(400);

    const oversized = await POST(new Request("http://localhost/api/documents/doc-a/conversations", {
      method: "POST",
      headers: { "Content-Length": String(641 * 1024), "Idempotency-Key": "conversation-create-0002" },
      body: "{}",
    }), { params: Promise.resolve({ id: "doc-a" }) });
    expect(oversized.status).toBe(413);

    vi.mocked(listConversations).mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const notFound = await GET(new Request("http://localhost/api/documents/hidden/conversations"), {
      params: Promise.resolve({ id: "hidden" }),
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "Conversation resource not found" });
  });

  it("advertises protected methods", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, POST, OPTIONS");
  });
});
