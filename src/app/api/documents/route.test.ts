import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentDraft } from "@/features/documents/document-repository";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
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
});
