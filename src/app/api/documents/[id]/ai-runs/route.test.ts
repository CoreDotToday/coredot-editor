import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAiRunSummariesPage } from "@/features/ai/ai-run-repository";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET } from "./route";

vi.mock("@/features/ai/ai-run-repository", () => ({ listAiRunSummariesPage: vi.fn() }));

describe("GET /api/documents/[id]/ai-runs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a bounded scoped summary page", async () => {
    vi.mocked(listAiRunSummariesPage).mockResolvedValueOnce({
      items: [{ id: "run_1", commandType: "document_review", status: "completed", createdAt: new Date(0) }],
      nextCursor: "next",
    });
    const response = await GET(
      new Request("http://localhost/api/documents/doc_1/ai-runs?cursor=cursor&limit=10"),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    expect(listAiRunSummariesPage).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "doc_1", { cursor: "cursor", limit: 10 });
    const body = await response.json();
    expect(body.nextCursor).toBe("next");
    expect(body.runs[0]).not.toHaveProperty("outputText");
  });
});
