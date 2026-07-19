import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProposalRecord, DocumentChangeRecord, DocumentRecord } from "@/db/schema";
import { applyProposal } from "@/features/documents/document-change-service";
import { DOCUMENT_REQUEST_BODY_BYTES } from "@/features/security/resource-policy";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { POST } from "./route";

vi.mock("@/features/documents/document-change-service", () => ({ applyProposal: vi.fn() }));

const createdAt = new Date("2026-01-01T00:00:00.000Z");

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
    appliedMode: "replace",
    status: "accepted",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createDocumentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc_1",
    workspaceId: "vitest-workspace",
    creationKey: "internal-recovery-key-123456",
    title: "Dirty draft",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] },
    plainText: "new",
    status: "draft",
    readiness: "needs_review",
    metadataJson: { owner: "Legal" },
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createChangeRecord(overrides: Partial<DocumentChangeRecord> = {}): DocumentChangeRecord {
  return {
    id: "change_1",
    workspaceId: "vitest-workspace",
    documentId: "doc_1",
    principalId: TEST_REQUEST_CONTEXT.principalId,
    requestId: TEST_REQUEST_CONTEXT.requestId,
    kind: "single",
    batchId: null,
    beforeSnapshotJson: { ...createValidPayload().document, readiness: "needs_review" },
    afterRevision: 1,
    createdAt,
    undoneAt: null,
    ...overrides,
  };
}

function createValidPayload() {
  return {
    appliedMode: "replace",
    document: {
      id: "doc_1",
      title: "Dirty draft",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] },
      metadataJson: { owner: "Legal" },
    },
    expectedRevision: 0,
  };
}

function createJsonRequest(body: unknown, headers?: HeadersInit) {
  return new Request("http://localhost/api/proposals/proposal_1/apply", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

function createContext(id = "proposal_1") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/proposals/[id]/apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects readiness smuggling before proposal service access", async () => {
    const base = createValidPayload();
    const payload = { ...base, document: { ...base.document, readiness: "approved" } };

    const response = await POST(createJsonRequest(payload), createContext());

    expect(response.status).toBe(400);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("applies a proposal to the bounded submitted dirty draft and expected revision", async () => {
    vi.mocked(applyProposal).mockResolvedValueOnce({
      change: createChangeRecord(),
      document: createDocumentRecord(),
      ok: true,
      proposals: [createProposalRecord()],
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      change: { id: "change_1" },
      document: { id: "doc_1", revision: 1 },
      proposal: { id: "proposal_1", status: "accepted" },
    });
    expect(body.change).toEqual({
      afterRevision: 1,
      batchId: null,
      createdAt: createdAt.toISOString(),
      documentId: "doc_1",
      id: "change_1",
      kind: "single",
      undoneAt: null,
    });
    expect(body.document).not.toHaveProperty("creationKey");
    expect(applyProposal).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      documentId: "doc_1",
      draft: {
        title: "Dirty draft",
        contentJson: createValidPayload().document.contentJson,
        metadataJson: { owner: "Legal" },
      },
      expectedRevision: 0,
      mode: "replace",
      proposalId: "proposal_1",
    });
  });

  it("returns the latest document on a revision conflict", async () => {
    vi.mocked(applyProposal).mockResolvedValueOnce({
      document: createDocumentRecord({ revision: 7 }),
      ok: false,
      reason: "revision_conflict",
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "revision_conflict", document: { revision: 7 } });
  });

  it("returns the stable collaboration fence conflict", async () => {
    vi.mocked(applyProposal).mockResolvedValueOnce({
      ok: false,
      reason: "collaboration_initialized",
    });

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Document collaboration is already initialized",
      reason: "collaboration_initialized",
    });
  });

  it("maps active Project Profile violations to a stable 400 response", async () => {
    vi.mocked(applyProposal).mockResolvedValueOnce({
      ok: false,
      reason: "invalid_profile",
      violation: {
        current: "draft",
        next: "approved",
        reason: "invalid_readiness_transition",
      },
    } as never);

    const response = await POST(createJsonRequest(createValidPayload()), createContext());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: {
        current: "draft",
        next: "approved",
        reason: "invalid_readiness_transition",
      },
    });
  });

  it("maps missing, status, and proposal application failures", async () => {
    vi.mocked(applyProposal)
      .mockResolvedValueOnce({ ok: false, reason: "not_found" })
      .mockResolvedValueOnce({ ok: false, reason: "status_conflict", proposals: [createProposalRecord()] })
      .mockResolvedValueOnce({
        applyFailureReason: "target_not_found",
        ok: false,
        reason: "proposal_apply_failed",
      });

    await expect(POST(createJsonRequest(createValidPayload()), createContext())).resolves.toMatchObject({ status: 404 });
    await expect(POST(createJsonRequest(createValidPayload()), createContext())).resolves.toMatchObject({ status: 409 });
    const applyFailure = await POST(createJsonRequest(createValidPayload()), createContext());
    expect(applyFailure.status).toBe(409);
    expect(await applyFailure.json()).toMatchObject({ reason: "target_not_found" });
  });

  it("rejects malformed or structurally invalid dirty drafts", async () => {
    const invalidPayload = createValidPayload();
    invalidPayload.document.contentJson.content = [{} as never];

    const response = await POST(createJsonRequest(invalidPayload), createContext());

    expect(response.status).toBe(413);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("rejects declared oversized request bodies before service access", async () => {
    const response = await POST(createJsonRequest(createValidPayload(), {
      "Content-Length": String(DOCUMENT_REQUEST_BODY_BYTES + 1),
    }), createContext());

    expect(response.status).toBe(413);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("requires the dirty document, mode, and expected revision", async () => {
    const response = await POST(createJsonRequest({ document: { id: "doc_1" } }), createContext());

    expect(response.status).toBe(400);
    expect(applyProposal).not.toHaveBeenCalled();
  });
});
