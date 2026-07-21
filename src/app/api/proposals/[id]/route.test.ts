import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProposalById, updateProposalStatus } from "@/features/proposals/proposal-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { ProposalStatusUpdateConflictError } from "@/features/proposals/proposal-status-errors";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET, PATCH } from "./route";

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
  } as NonNullable<Awaited<ReturnType<typeof getProposalById>>>;
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
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("updates non-accepted proposal status", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(createProposalRecord({ appliedMode: null, status: "rejected" }));

    const response = await PATCH(createJsonRequest({ status: "rejected" }), createContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { id: "proposal_1", status: "rejected" } });
    expect(updateProposalStatus).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "proposal_1", "rejected", undefined, {
      expectedStatus: undefined,
    });
  });

  it("returns exact scoped proposal detail for lazy hydration", async () => {
    vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({
      targetText: "t".repeat(1_000),
      replacementText: "r".repeat(3_000),
    }));

    const response = await GET(new Request("http://localhost/api/proposals/proposal_1"), createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.proposal.targetText).toHaveLength(1_000);
    expect(body.proposal.replacementText).toHaveLength(3_000);
    expect(body.proposal).not.toHaveProperty("workspaceId");
    expect(body.proposal).not.toHaveProperty("aiRunId");
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

  it.each(["pending", "rejected"] as const)(
    "rejects changing an accepted proposal to %s outside document change undo",
    async (status) => {
      vi.mocked(updateProposalStatus).mockResolvedValueOnce(null as never);
      vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({ status: "accepted" }));

      const response = await PATCH(
        createJsonRequest({ status, ...(status === "rejected" ? { expectedStatus: "accepted" } : {}) }),
        createContext(),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "Accepted proposals may only be reset by document change undo",
        proposal: { id: "proposal_1", status: "accepted" },
      });
    },
  );

  it("allows a rejected proposal to return to pending", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(createProposalRecord({ status: "pending" }));

    const response = await PATCH(
      createJsonRequest({ status: "pending", expectedStatus: "rejected" }),
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { id: "proposal_1", status: "pending" } });
  });

  it("returns a stable 409 reason when collaboration initialization invalidated an anchorless reset", async () => {
    vi.mocked(updateProposalStatus).mockRejectedValueOnce(new ProposalStatusUpdateConflictError());
    vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({ status: "rejected" }));

    const response = await PATCH(
      createJsonRequest({ status: "pending", expectedStatus: "rejected" }),
      createContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Collaboration proposal anchor is required",
      proposal: { id: "proposal_1", status: "rejected" },
      reason: "collaboration_anchor_required",
    });
  });

  it("returns 409 when the proposal status changed from the caller expectation", async () => {
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof updateProposalStatus>>,
    );
    vi.mocked(getProposalById).mockResolvedValueOnce(createProposalRecord({ status: "rejected" }));

    const response = await PATCH(
      createJsonRequest({ status: "rejected", expectedStatus: "pending" }),
      createContext("proposal_1"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Proposal status changed",
      proposal: { id: "proposal_1", status: "rejected" },
    });
    expect(updateProposalStatus).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "proposal_1", "rejected", undefined, {
      expectedStatus: "pending",
    });
    expect(getProposalById).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "proposal_1");
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

  it("returns 404 without leaking or mutating another workspace's proposal", async () => {
    const workspaceBContext = {
      ...TEST_REQUEST_CONTEXT,
      principalId: "principal-b",
      requestId: "request-b",
      workspaceId: "workspace-b",
    };
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => workspaceBContext,
    });
    vi.mocked(updateProposalStatus).mockResolvedValueOnce(null as never);
    vi.mocked(getProposalById).mockResolvedValueOnce(null as never);

    const response = await PATCH(createJsonRequest({ status: "rejected" }), createContext());

    expect(response.status).toBe(404);
    expect(updateProposalStatus).toHaveBeenCalledWith(
      workspaceBContext,
      "proposal_1",
      "rejected",
      undefined,
      { expectedStatus: undefined },
    );
    expect(getProposalById).toHaveBeenCalledWith(workspaceBContext, "proposal_1");
  });
});
