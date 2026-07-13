import { describe, expect, it, vi } from "vitest";
import { createHttpConversationStore } from "./conversation-client";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const conversation = {
  archived: false,
  command: "Rewrite",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentId: "doc-a",
  id: "conversation-a",
  latestAiRunId: null,
  latestProposalId: null,
  messageCount: 1,
  messages: [{
    aiRunId: null,
    command: "Rewrite",
    content: "Original",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "message-a",
    proposalId: null,
    role: "user",
    scopeLabel: null,
  }],
  retentionExpiresAt: null,
  status: "idle",
  title: "Rewrite",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

describe("HTTP conversation store", () => {
  it("rejects proposal-only links before issuing an HTTP request", async () => {
    const request = vi.fn();
    const store = createHttpConversationStore(request);
    await expect(store.append("doc-a", "conversation-a", {
      content: "Answer",
      expectedVersion: 1,
      mutationKey: "proposal-only-key-0001",
      proposalId: "proposal-a",
      role: "assistant",
      status: "idle",
    })).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it("loads and mutates canonical conversations with idempotency headers", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ conversations: [{ ...conversation, messages: undefined }], nextCursor: null }))
      .mockResolvedValueOnce(response({ conversation }))
      .mockResolvedValueOnce(response({ conversation, replayed: false }, 201))
      .mockResolvedValueOnce(response({ conversation: { ...conversation, version: 2 }, replayed: false }));
    const store = createHttpConversationStore(request);

    await expect(store.list({ documentId: "doc-a" })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ createdAt: expect.any(Date), syncStatus: "saved" }] },
    });
    await expect(store.get("doc-a", "conversation-a")).resolves.toMatchObject({
      ok: true,
      value: { messages: [{ content: "Original" }], syncStatus: "saved" },
    });
    await store.create({
      command: "Rewrite",
      creationKey: "create-conversation-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "create-message-key-0001", role: "user" },
      retentionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      title: "Rewrite",
    });
    await store.append("doc-a", "conversation-a", {
      content: "Answer",
      expectedVersion: 1,
      mutationKey: "append-message-key-0001",
      role: "assistant",
      status: "idle",
    });

    expect(request).toHaveBeenNthCalledWith(3, "/api/documents/doc-a/conversations", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "create-conversation-key-0001" }),
    }));
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toMatchObject({
      retentionExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(request).toHaveBeenNthCalledWith(4, "/api/conversations/conversation-a/messages", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "append-message-key-0001" }),
    }));
  });

  it("maps expected failures and malformed successes without throwing", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ reason: "conflict" }, 409))
      .mockResolvedValueOnce(response({ conversation: { id: "broken" } }));
    const store = createHttpConversationStore(request);
    await expect(store.rename("doc-a", "conversation-a", { expectedVersion: 1, title: "New" }))
      .resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(store.archive("doc-a", "conversation-a", { archived: true, expectedVersion: 1 }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
