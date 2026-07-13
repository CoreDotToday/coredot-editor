import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendConversationMessage } from "@/features/ai/conversation-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { OPTIONS, POST } from "./route";

vi.mock("@/features/ai/conversation-repository", () => ({
  appendConversationMessage: vi.fn(),
  CONVERSATION_LIMITS: { commandCharacters: 200, messageCharacters: 100_000, scopeLabelCharacters: 120 },
}));
vi.mock("@/features/security/request-budget", () => ({ enforceRequestBudget: vi.fn(async () => null) }));

describe("POST /api/conversations/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("appends a bounded linked message with a required mutation key", async () => {
    vi.mocked(appendConversationMessage).mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const response = await POST(new Request("http://localhost/api/conversations/conversation-a/messages", {
      method: "POST",
      headers: { "Idempotency-Key": "append-message-key-0001" },
      body: JSON.stringify({
        aiRunId: "run-a",
        content: "Answer",
        expectedVersion: 1,
        proposalId: "proposal-a",
        role: "assistant",
        status: "idle",
      }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(404);
    expect(appendConversationMessage).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "conversation-a", {
      aiRunId: "run-a",
      command: null,
      content: "Answer",
      expectedVersion: 1,
      mutationKey: "append-message-key-0001",
      proposalId: "proposal-a",
      role: "assistant",
      scopeLabel: null,
      status: "idle",
    });
  });

  it("rejects a missing key and advertises protected methods", async () => {
    const response = await POST(new Request("http://localhost/api/conversations/conversation-a/messages", {
      method: "POST",
      body: JSON.stringify({ content: "Answer", expectedVersion: 1, role: "assistant", status: "idle" }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(400);
    expect(appendConversationMessage).not.toHaveBeenCalled();
    expect((await OPTIONS()).headers.get("Allow")).toBe("POST, OPTIONS");
  });

  it("rejects a proposal link without its resolved AI run", async () => {
    const response = await POST(new Request("http://localhost/api/conversations/conversation-a/messages", {
      method: "POST",
      headers: { "Idempotency-Key": "proposal-only-key-0001" },
      body: JSON.stringify({
        content: "Answer",
        expectedVersion: 1,
        proposalId: "proposal-a",
        role: "assistant",
        status: "idle",
      }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(400);
    expect(appendConversationMessage).not.toHaveBeenCalled();
  });
});
