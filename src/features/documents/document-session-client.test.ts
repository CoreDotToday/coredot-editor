import { describe, expect, it, vi } from "vitest";
import {
  createDocumentSessionClient,
  DocumentSessionConflictError,
  type DocumentSessionDraft,
} from "./document-session-client";

const draft: DocumentSessionDraft = {
  title: "Local title",
  contentJson: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Local body" }] }],
  },
  metadataJson: { owner: "Legal" },
  readiness: "needs_review",
};

const serverDocument = {
  id: "doc_1",
  ...draft,
  revision: 4,
};

const change = {
  id: "change_1",
  documentId: "doc_1",
  kind: "single" as const,
  batchId: null,
  afterRevision: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  undoneAt: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("document session client", () => {
  it("returns a parsed saved state and sends the revision precondition", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ document: serverDocument }));
    const client = createDocumentSessionClient(request);

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "saved",
      document: serverDocument,
    });
    expect(request).toHaveBeenCalledWith("/api/documents/doc_1", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ ...draft, expectedRevision: 3 }),
    }));
  });

  it("preserves both local and server drafts as an explicit save conflict", async () => {
    const latest = { ...serverDocument, title: "Server title", revision: 7 };
    const request = vi.fn().mockResolvedValue(jsonResponse({
      document: latest,
      reason: "revision_conflict",
    }, 409));

    await expect(createDocumentSessionClient(request).save("doc_1", draft, 3)).resolves.toEqual({
      kind: "conflict",
      localDraft: draft,
      serverDocument: latest,
    });
  });

  it("parses durable change identity for single, bulk, and undo responses", async () => {
    const proposal = {
      id: "proposal_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer",
      source: "review",
      command: null,
      occurrenceIndex: null,
      targetFrom: null,
      targetTo: null,
      defaultApplyMode: "replace",
      appliedMode: "replace",
      status: "accepted",
    };
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ change, document: serverDocument, proposal }))
      .mockResolvedValueOnce(jsonResponse({
        change: { ...change, id: "change_batch", kind: "batch", batchId: "batch_1" },
        document: serverDocument,
        proposals: [proposal, { ...proposal, id: "proposal_2" }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        change: { ...change, undoneAt: "2026-01-02T00:00:00.000Z" },
        document: { ...serverDocument, revision: 5 },
        proposals: [{ ...proposal, status: "pending" }],
      }));
    const client = createDocumentSessionClient(request);

    await expect(client.applyProposal("proposal_1", {
      appliedMode: "replace",
      document: { id: "doc_1", ...draft },
      expectedRevision: 3,
    })).resolves.toMatchObject({ change: { id: "change_1" }, proposals: [{ id: "proposal_1" }] });
    await expect(client.applyProposalBatch({
      document: { id: "doc_1", ...draft },
      expectedRevision: 3,
      proposals: [
        { id: "proposal_1", appliedMode: "replace" },
        { id: "proposal_2", appliedMode: "insert_below" },
      ],
    })).resolves.toMatchObject({ change: { id: "change_batch", kind: "batch" }, proposals: { length: 2 } });
    await expect(client.undoChange("change_1", 4)).resolves.toMatchObject({
      change: { id: "change_1", undoneAt: "2026-01-02T00:00:00.000Z" },
      document: { revision: 5 },
      proposals: [{ status: "pending" }],
    });
  });

  it.each([
    ["single apply", (client: ReturnType<typeof createDocumentSessionClient>) => client.applyProposal("proposal_1", {
      appliedMode: "replace",
      document: { id: "doc_1", ...draft },
      expectedRevision: 3,
    })],
    ["bulk apply", (client: ReturnType<typeof createDocumentSessionClient>) => client.applyProposalBatch({
      document: { id: "doc_1", ...draft },
      expectedRevision: 3,
      proposals: [{ appliedMode: "replace" as const, id: "proposal_1" }],
    })],
    ["undo", (client: ReturnType<typeof createDocumentSessionClient>) => client.undoChange("change_1", 3)],
  ])("preserves the validated server document for a %s revision conflict", async (_, requestChange) => {
    const latest = { ...serverDocument, title: "Latest server title", revision: 9 };
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      document: latest,
      reason: "revision_conflict",
    }, 409)));

    const result = requestChange(client);
    await expect(result).rejects.toBeInstanceOf(DocumentSessionConflictError);
    await expect(result).rejects.toMatchObject({
      name: "DocumentSessionConflictError",
      status: 409,
      serverDocument: latest,
    });
  });

  it("rejects malformed successful change responses", async () => {

    const malformedClient = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({ document: {} })));
    await expect(malformedClient.undoChange("change_1", 4)).rejects.toMatchObject({
      name: "DocumentSessionRequestError",
      status: 200,
    });
  });

  it("loads paginated durable history and creates a full draft", async () => {
    const historyChange = {
      ...change,
      proposals: [{
        id: "proposal_1",
        targetText: "old",
        replacementText: "new",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ changes: [historyChange], nextCursor: "change_1" }))
      .mockResolvedValueOnce(jsonResponse({
        document: { ...serverDocument, id: "doc_copy", revision: 0 },
        replayed: true,
      }, 200));
    const client = createDocumentSessionClient(request);

    await expect(client.listChanges("doc_1", { cursor: "older", limit: 10 })).resolves.toEqual({
      changes: [historyChange],
      nextCursor: "change_1",
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/document-changes?documentId=doc_1&limit=10&cursor=older",
      { method: "GET" },
    );
    await expect(client.createFromDraft(draft, "recovery-key-123456")).resolves.toMatchObject({
      document: { id: "doc_copy", revision: 0 },
      replayed: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/documents", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Idempotency-Key": "recovery-key-123456" }),
      body: JSON.stringify(draft),
    }));
  });
});
