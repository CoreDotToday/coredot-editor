import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProposalSummariesPage } from "@/features/proposals/proposal-repository";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET } from "./route";

vi.mock("@/features/proposals/proposal-repository", () => ({ listProposalSummariesPage: vi.fn() }));

describe("GET /api/documents/[id]/proposals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a bounded scoped summary page", async () => {
    vi.mocked(listProposalSummariesPage).mockResolvedValueOnce({
      items: [{ id: "proposal_1", status: "pending", createdAt: new Date(0), isTruncated: true }],
      nextCursor: null,
    } as never);
    const response = await GET(
      new Request("http://localhost/api/documents/doc_1/proposals?limit=10"),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    expect(listProposalSummariesPage).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "doc_1", { cursor: undefined, limit: 10 });
    const body = await response.json();
    expect(body.nextCursor).toBeNull();
    expect(body.proposals[0]).not.toHaveProperty("workspaceId");
    expect(body.proposals[0].isTruncated).toBe(true);
    expect(typeof body.proposals[0].isTruncated).toBe("boolean");
  });
});
