import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProposalById, updateProposalStatus } from "@/features/proposals/proposal-repository";
import { PATCH } from "./route";

vi.mock("@/features/proposals/proposal-repository", () => ({
  getProposalById: vi.fn(),
  updateProposalStatus: vi.fn(),
}));

function createProposalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal_1",
    aiRunId: "run_1",
    documentId: "doc_1",
    targetText: "old",
    replacementText: "new",
    explanation: "Clearer.",
    source: "selection",
    command: "Improve clarity",
    defaultApplyMode: "replace",
    appliedMode: null,
    status: "accepted",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Awaited<ReturnType<typeof updateProposalStatus>>;
}

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

  it("updates non-accepted proposal status", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(createProposalRecord({ appliedMode: null, status: "rejected" }));

    const response = await PATCH(createJsonRequest({ status: "rejected" }), createContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { id: "proposal_1", status: "rejected" } });
    expect(updateProposalStatus).toHaveBeenCalledWith({ workspaceId: "local" }, "proposal_1", "rejected", undefined, {
      expectedStatus: undefined,
    });
  });

  it("rejects accepted status updates", async () => {
    const response = await PATCH(createJsonRequest({ status: "accepted" }), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Use proposal apply endpoint for accepted proposals" });
    expect(updateProposalStatus).not.toHaveBeenCalled();
  });

  it("rejects accepted status updates even when an applied mode is provided", async () => {
    const response = await PATCH(
      createJsonRequest({ status: "accepted", appliedMode: "replace" }),
      createContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Use proposal apply endpoint for accepted proposals" });
    expect(updateProposalStatus).not.toHaveBeenCalled();
  });

  it("returns 409 when the proposal status changed from the caller expectation", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof updateProposalStatus>>,
    );
    vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({ status: "accepted" }));

    const response = await PATCH(
      createJsonRequest({ status: "rejected", expectedStatus: "pending" }),
      createContext("proposal_1"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Proposal status changed",
      proposal: { id: "proposal_1", status: "accepted" },
    });
    expect(updateProposalStatus).toHaveBeenCalledWith({ workspaceId: "local" }, "proposal_1", "rejected", undefined, {
      expectedStatus: "pending",
    });
    expect(getProposalById).toHaveBeenCalledWith({ workspaceId: "local" }, "proposal_1");
  });

  it("returns 409 instead of 404 when a conditional update misses an existing proposal", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof updateProposalStatus>>,
    );
    vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({ status: "pending" }));

    const response = await PATCH(
      createJsonRequest({ status: "rejected", expectedStatus: "pending" }),
      createContext("proposal_1"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Proposal update conflict",
      proposal: { id: "proposal_1", status: "pending" },
    });
  });

  it("rejects invalid statuses", async () => {
    const response = await PATCH(createJsonRequest({ status: "done" }), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(updateProposalStatus).not.toHaveBeenCalled();
  });

  it("rejects invalid applied modes", async () => {
    const response = await PATCH(createJsonRequest({ status: "accepted", appliedMode: "append" }), createContext());

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
