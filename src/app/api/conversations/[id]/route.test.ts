import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveConversation, renameConversation, setConversationStatus } from "@/features/ai/conversation-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { OPTIONS, PATCH } from "./route";

vi.mock("@/features/ai/conversation-repository", () => ({
  archiveConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationStatus: vi.fn(),
  CONVERSATION_LIMITS: { titleCharacters: 120 },
}));
vi.mock("@/features/security/request-budget", () => ({ enforceRequestBudget: vi.fn(async () => null) }));

describe("PATCH /api/conversations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it.each([
    ["rename", { action: "rename", expectedVersion: 1, title: "New title" }, renameConversation],
    ["archive", { action: "archive", archived: true, expectedVersion: 1 }, archiveConversation],
    ["status", { action: "status", expectedVersion: 1, status: "failed" }, setConversationStatus],
  ] as const)("dispatches strict %s mutations", async (_name, body, operation) => {
    vi.mocked(operation).mockResolvedValueOnce({ ok: false, reason: "conflict" });
    const response = await PATCH(new Request("http://localhost/api/conversations/conversation-a", {
      method: "PATCH",
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(409);
    expect(operation).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "conversation-a", expect.objectContaining({
      expectedVersion: 1,
    }));
  });

  it("rejects unknown actions and fields before repository access", async () => {
    const response = await PATCH(new Request("http://localhost/api/conversations/conversation-a", {
      method: "PATCH",
      body: JSON.stringify({ action: "rename", expectedVersion: 1, title: "New", extra: true }),
    }), { params: Promise.resolve({ id: "conversation-a" }) });
    expect(response.status).toBe(400);
    expect(renameConversation).not.toHaveBeenCalled();
  });

  it("advertises PATCH and OPTIONS", async () => {
    const response = await OPTIONS();
    expect(response.headers.get("Allow")).toBe("PATCH, OPTIONS");
  });
});
