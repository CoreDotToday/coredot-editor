import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProposalRecord, DocumentChangeRecord, DocumentRecord } from "@/db/schema";
import { applyProposalBatch } from "@/features/documents/document-change-service";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { POST } from "./route";

vi.mock("@/features/documents/document-change-service", () => ({ applyProposalBatch: vi.fn() }));

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const dirtyDocument = {
  id: "doc_1",
  title: "Dirty draft",
  contentJson: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "alpha beta" }] }] },
  metadataJson: {},
  readiness: "draft" as const,
};

function proposal(id: string): AiProposalRecord {
  return {
    id,
    workspaceId: "vitest-workspace",
    aiRunId: `run_${id}`,
    documentId: "doc_1",
    targetText: id,
    replacementText: id.toUpperCase(),
    explanation: "Clearer",
    source: "review",
    command: null,
    occurrenceIndex: null,
    targetFrom: null,
    targetTo: null,
    defaultApplyMode: "replace",
    appliedMode: "replace",
    status: "accepted",
    createdAt,
    updatedAt: createdAt,
  };
}

function successResult() {
  return {
    change: {
      id: "change_batch",
      workspaceId: "vitest-workspace",
      documentId: "doc_1",
      principalId: TEST_REQUEST_CONTEXT.principalId,
      requestId: TEST_REQUEST_CONTEXT.requestId,
      kind: "batch" as const,
      batchId: "batch_1",
      beforeSnapshotJson: dirtyDocument,
      afterRevision: 1,
      createdAt,
      undoneAt: null,
    } satisfies DocumentChangeRecord,
    document: {
      ...dirtyDocument,
      workspaceId: "vitest-workspace",
      creationKey: null,
      plainText: "ALPHA BETA",
      status: "draft" as const,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    } satisfies DocumentRecord,
    ok: true as const,
    proposals: [proposal("proposal_1"), proposal("proposal_2")],
  };
}

function payload() {
  return {
    document: dirtyDocument,
    expectedRevision: 0,
    proposals: [
      { id: "proposal_1", appliedMode: "replace" },
      { id: "proposal_2", appliedMode: "insert_below" },
    ],
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/proposals/bulk-apply", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/proposals/bulk-apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies a bounded proposal batch in one service call", async () => {
    vi.mocked(applyProposalBatch).mockResolvedValueOnce(successResult());

    const response = await POST(request(payload()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      change: { id: "change_batch", kind: "batch" },
      document: { revision: 1 },
      proposals: [{ id: "proposal_1" }, { id: "proposal_2" }],
    });
    expect(applyProposalBatch).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      documentId: "doc_1",
      draft: {
        title: "Dirty draft",
        contentJson: dirtyDocument.contentJson,
        metadataJson: {},
        readiness: "draft",
      },
      expectedRevision: 0,
      proposals: [
        { proposalId: "proposal_1", mode: "replace" },
        { proposalId: "proposal_2", mode: "insert_below" },
      ],
    });
  });

  it("rejects duplicate proposal ids and oversized batches", async () => {
    const duplicate = payload();
    duplicate.proposals[1] = { id: "proposal_1", appliedMode: "insert_below" };
    expect((await POST(request(duplicate))).status).toBe(400);

    const oversized = payload();
    oversized.proposals = Array.from({ length: RESOURCE_LIMITS.proposalBatchItems + 1 }, (_, index) => ({
      id: `proposal_${String(index)}`,
      appliedMode: "replace",
    }));
    expect((await POST(request(oversized))).status).toBe(413);
    expect(applyProposalBatch).not.toHaveBeenCalled();
  });

  it("returns 409 without partial success when any proposal fails", async () => {
    vi.mocked(applyProposalBatch).mockResolvedValueOnce({
      applyFailureReason: "target_not_found",
      ok: false,
      reason: "proposal_apply_failed",
      proposals: [proposal("proposal_1"), proposal("proposal_2")],
    });

    const response = await POST(request(payload()));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "target_not_found" });
  });
});
