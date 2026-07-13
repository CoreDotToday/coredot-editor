import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProposalRecord, DocumentRecord } from "@/db/schema";
import { applyProposalToDocumentDraft } from "@/features/proposals/proposal-application-service";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { POST } from "./route";

vi.mock("@/features/proposals/proposal-application-service", () => ({
  applyProposalToDocumentDraft: vi.fn(),
}));

function createProposalRecord(overrides: Partial<AiProposalRecord> = {}): AiProposalRecord {
  return {
    id: "proposal_1",
    workspaceId: "vitest-workspace",
    aiRunId: "run_1",
    documentId: "doc_1",
    targetText: "old",
    replacementText: "new",
    explanation: "Clearer.",
    source: "selection",
    command: "Improve clarity",
    occurrenceIndex: null,
    targetFrom: null,
    targetTo: null,
    defaultApplyMode: "replace",
    appliedMode: null,
    status: "pending",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createDocumentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc_1",
    workspaceId: "vitest-workspace",
    title: "Market Entry Memo",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] },
    plainText: "new",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
    revision: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/proposals/proposal_1/apply", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function createContext(id = "proposal_1") {
  return { params: Promise.resolve({ id }) };
}

function createValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    appliedMode: "replace",
    document: {
      id: "doc_1",
      title: "Market Entry Memo",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] },
      metadataJson: { owner: "Legal" },
      readiness: "needs_review",
    },
    expectedDocumentContentSignature: "{\"type\":\"doc\",\"content\":[]}",
    expectedStatus: "pending",
    ...overrides,
  };
}

describe("POST /api/proposals/[id]/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies a proposal to the submitted document draft", async () => {
    vi.mocked(applyProposalToDocumentDraft).mockResolvedValueOnce({
      document: createDocumentRecord({ title: "Updated Memo" }),
      ok: true,
      proposal: createProposalRecord({ appliedMode: "replace", status: "accepted" }),
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      document: { id: "doc_1", title: "Updated Memo" },
      proposal: { id: "proposal_1", appliedMode: "replace", status: "accepted" },
    });
    expect(applyProposalToDocumentDraft).toHaveBeenCalledWith(
      TEST_REQUEST_CONTEXT,
      {
        appliedMode: "replace",
        draft: {
          id: "doc_1",
        },
        expectedDocumentContentSignature: "{\"type\":\"doc\",\"content\":[]}",
        expectedStatus: "pending",
        proposalId: "proposal_1",
      },
    );
  });

  it("returns 409 when the proposal status changed", async () => {
    vi.mocked(applyProposalToDocumentDraft).mockResolvedValueOnce({
      error: "proposal_status_changed",
      ok: false,
      proposal: createProposalRecord({ status: "accepted" }),
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Proposal status changed",
      proposal: { id: "proposal_1", status: "accepted" },
    });
  });

  it("returns 409 when the submitted draft no longer matches the proposal target", async () => {
    vi.mocked(applyProposalToDocumentDraft).mockResolvedValueOnce({
      applyFailureReason: "stale_selection",
      error: "proposal_apply_failed",
      ok: false,
      proposal: createProposalRecord(),
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Proposal could not be applied to the submitted document",
      reason: "stale_selection",
      proposal: { id: "proposal_1", status: "pending" },
    });
  });

  it("returns 409 when the server document changed before proposal application", async () => {
    vi.mocked(applyProposalToDocumentDraft).mockResolvedValueOnce({
      document: createDocumentRecord({ plainText: "newer saved text" }),
      error: "document_changed",
      ok: false,
      proposal: createProposalRecord(),
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      document: { id: "doc_1", plainText: "newer saved text" },
      error: "Document changed before proposal application",
      proposal: { id: "proposal_1", status: "pending" },
    });
  });

  it("returns 404 when the proposal does not exist", async () => {
    vi.mocked(applyProposalToDocumentDraft).mockResolvedValueOnce({
      error: "proposal_not_found",
      ok: false,
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext("missing_proposal"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Proposal not found" });
  });

  it("rejects invalid apply payloads", async () => {
    const response = await POST(createJsonRequest({ appliedMode: "append" }), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(applyProposalToDocumentDraft).not.toHaveBeenCalled();
  });

  it("requires a server content signature precondition", async () => {
    const payload = createValidPayload();
    delete (payload as Partial<ReturnType<typeof createValidPayload>>).expectedDocumentContentSignature;

    const response = await POST(createJsonRequest(payload), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(applyProposalToDocumentDraft).not.toHaveBeenCalled();
  });
});
