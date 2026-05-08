import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateProposalStatus } from "@/features/proposals/proposal-repository";
import { PATCH } from "./route";

vi.mock("@/features/proposals/proposal-repository", () => ({
  updateProposalStatus: vi.fn(),
}));

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/proposals/proposal_1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function createContext(id = "proposal_1") {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/proposals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates proposal status", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce({
      id: "proposal_1",
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer.",
      status: "accepted",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await PATCH(createJsonRequest({ status: "accepted" }), createContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { id: "proposal_1", status: "accepted" } });
    expect(updateProposalStatus).toHaveBeenCalledWith("proposal_1", "accepted");
  });

  it("rejects invalid statuses", async () => {
    const response = await PATCH(createJsonRequest({ status: "done" }), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(updateProposalStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when the proposal does not exist", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof updateProposalStatus>>,
    );

    const response = await PATCH(createJsonRequest({ status: "rejected" }), createContext("missing_proposal"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Proposal not found" });
  });
});
