import { beforeEach, describe, expect, it, vi } from "vitest";
import { forkConversation } from "@/features/ai/conversation-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { OPTIONS, POST } from "./route";

vi.mock("@/features/ai/conversation-repository", () => ({
  forkConversation: vi.fn(),
  CONVERSATION_LIMITS: { titleCharacters: 120 },
}));
vi.mock("@/features/security/request-budget", () => ({ enforceRequestBudget: vi.fn(async () => null) }));

describe("POST /api/conversations/[id]/fork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("forks through one scoped message with an idempotency key", async () => {
    vi.mocked(forkConversation).mockResolvedValueOnce({ ok: false, reason: "conflict" });
    const response = await POST(new Request("http://localhost/api/conversations/conversation-a/fork", {
      method: "POST",
      headers: { "Idempotency-Key": "fork-conversation-key-0001" },
      body: JSON.stringify({ throughMessageId: "message-a", title: "Branch" }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(409);
    expect(forkConversation).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "conversation-a", {
      creationKey: "fork-conversation-key-0001",
      throughMessageId: "message-a",
      title: "Branch",
    });
  });

  it("rejects invalid input and advertises POST", async () => {
    const response = await POST(new Request("http://localhost/api/conversations/conversation-a/fork", {
      method: "POST",
      body: JSON.stringify({ throughMessageId: "", title: "" }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(400);
    expect((await OPTIONS()).headers.get("Allow")).toBe("POST, OPTIONS");
  });
});
