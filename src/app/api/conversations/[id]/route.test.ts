import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveConversation, getConversationById, renameConversation, setConversationStatus } from "@/features/ai/conversation-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET, OPTIONS, PATCH } from "./route";

vi.mock("@/features/ai/conversation-repository", () => ({
  archiveConversation: vi.fn(),
  getConversationById: vi.fn(),
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

  it("returns the full scoped transcript only from the detail route", async () => {
    vi.mocked(getConversationById).mockResolvedValueOnce({
      ok: true,
      value: {
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
          role: "user",
          scopeLabel: null,
        }],
        retentionExpiresAt: null,
        status: "idle",
        title: "Rewrite",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        version: 1,
      },
    });

    const response = await GET(new Request("http://localhost/api/conversations/conversation-a"), {
      params: Promise.resolve({ id: "conversation-a" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversation: { id: "conversation-a", messages: [{ content: "Original" }] },
    });
    expect(getConversationById).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "conversation-a");
  });

  it("returns 404 when retention makes the conversation detail unavailable", async () => {
    vi.mocked(getConversationById).mockResolvedValueOnce({ ok: false, reason: "not_found" });

    const response = await GET(new Request("http://localhost/api/conversations/conversation-expired"), {
      params: Promise.resolve({ id: "conversation-expired" }),
    });

    expect(response.status).toBe(404);
    expect(getConversationById).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "conversation-expired");
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
    expect(response.headers.get("Allow")).toBe("GET, HEAD, PATCH, OPTIONS");
  });
});
