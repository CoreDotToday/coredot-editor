import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentDraft, createDocumentFromDraft } from "@/features/documents/document-repository";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
  createDocumentFromDraft: vi.fn(),
  listDocuments: vi.fn(),
}));

describe("POST /api/documents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 429 before parsing or persistence when the budget is exhausted", async () => {
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAt: new Date(Date.now() + 5_000),
      })),
    });
    const request = { json: vi.fn() } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(request.json).not.toHaveBeenCalled();
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("rejects an unbounded title before persistence", async () => {
    const response = await POST(
      new Request("http://localhost/api/documents", {
        method: "POST",
        body: JSON.stringify({ title: "x".repeat(501) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("creates a full conflict-recovery draft in one persistence call", async () => {
    const draft = {
      title: "Recovered local draft",
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Local work" }] }],
      },
      metadataJson: { owner: "Legal" },
      readiness: "needs_review" as const,
    };
    vi.mocked(createDocumentFromDraft).mockResolvedValueOnce({
      id: "doc_recovered",
      workspaceId: "vitest-workspace",
      ...draft,
      plainText: "Local work",
      status: "draft",
      revision: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify(draft),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ document: { id: "doc_recovered", revision: 0 } });
    expect(createDocumentFromDraft).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "vitest-workspace",
    }), draft);
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });
});
