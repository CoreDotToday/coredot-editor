import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProposalRecord, DocumentChangeRecord, DocumentRecord } from "@/db/schema";
import { undoDocumentChange } from "@/features/documents/document-change-service";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { POST } from "./route";

vi.mock("@/features/documents/document-change-service", () => ({ undoDocumentChange: vi.fn() }));

const createdAt = new Date("2026-01-01T00:00:00.000Z");

function successResult() {
  const snapshot = {
    title: "Dirty draft",
    contentJson: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] },
    metadataJson: {},
    readiness: "draft" as const,
  };
  return {
    change: {
      id: "change_1",
      workspaceId: "vitest-workspace",
      documentId: "doc_1",
      principalId: TEST_REQUEST_CONTEXT.principalId,
      requestId: TEST_REQUEST_CONTEXT.requestId,
      kind: "single" as const,
      batchId: null,
      beforeSnapshotJson: snapshot,
      afterRevision: 1,
      createdAt,
      undoneAt: new Date("2026-01-02T00:00:00.000Z"),
    } satisfies DocumentChangeRecord,
    document: {
      id: "doc_1",
      workspaceId: "vitest-workspace",
      creationKey: null,
      ...snapshot,
      plainText: "before",
      status: "draft" as const,
      revision: 2,
      createdAt,
      updatedAt: createdAt,
    } satisfies DocumentRecord,
    ok: true as const,
    proposals: [{
      id: "proposal_1",
      workspaceId: "vitest-workspace",
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "before",
      replacementText: "after",
      explanation: "Clearer",
      source: "review" as const,
      command: null,
      occurrenceIndex: null,
      targetFrom: null,
      targetTo: null,
      defaultApplyMode: "replace" as const,
      appliedMode: null,
      status: "pending" as const,
      createdAt,
      updatedAt: createdAt,
    } satisfies AiProposalRecord],
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/document-changes/change_1/undo", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const routeContext = { params: Promise.resolve({ id: "change_1" }) };

describe("POST /api/document-changes/[id]/undo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("undoes a change with an explicit current revision", async () => {
    vi.mocked(undoDocumentChange).mockResolvedValueOnce(successResult());

    const response = await POST(request({ expectedRevision: 1 }), routeContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      change: { id: "change_1", undoneAt: expect.any(String) },
      document: { revision: 2 },
      proposals: [{ status: "pending" }],
    });
    expect(undoDocumentChange).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      changeId: "change_1",
      expectedRevision: 1,
    });
  });

  it("maps missing, revision, and one-shot status conflicts", async () => {
    vi.mocked(undoDocumentChange)
      .mockResolvedValueOnce({ ok: false, reason: "not_found" })
      .mockResolvedValueOnce({ ok: false, reason: "revision_conflict", document: successResult().document })
      .mockResolvedValueOnce({ ok: false, reason: "status_conflict" });

    expect((await POST(request({ expectedRevision: 1 }), routeContext)).status).toBe(404);
    expect((await POST(request({ expectedRevision: 1 }), routeContext)).status).toBe(409);
    expect((await POST(request({ expectedRevision: 2 }), routeContext)).status).toBe(409);
  });

  it("rejects missing or unsafe revision preconditions", async () => {
    expect((await POST(request({}), routeContext)).status).toBe(400);
    expect((await POST(request({ expectedRevision: -1 }), routeContext)).status).toBe(400);
    expect(undoDocumentChange).not.toHaveBeenCalled();
  });
});
