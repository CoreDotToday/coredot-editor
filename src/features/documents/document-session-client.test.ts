import { describe, expect, it, vi } from "vitest";
import {
  createDocumentSessionClient,
  DocumentSessionConflictError,
  DocumentSessionInvalidProfileError,
  DocumentSessionRequestError,
  DocumentWorkflowRequestError,
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
  it("returns a parsed saved state and omits server-owned readiness from the legacy save payload", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ document: serverDocument }));
    const client = createDocumentSessionClient(request);

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "saved",
      document: serverDocument,
    });
    expect(request).toHaveBeenCalledWith("/api/documents/doc_1", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        contentJson: draft.contentJson,
        expectedRevision: 3,
        metadataJson: draft.metadataJson,
        title: draft.title,
      }),
    }));
  });

  it("reads a validated server-authoritative workflow state for legacy and collaboration documents", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        workflow: {
          collaboration: null,
          documentId: "doc/legacy",
          readiness: "needs_review",
          revision: 7,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        workflow: {
          collaboration: { generation: 3, headSeq: 11 },
          documentId: "doc/collaborative",
          readiness: "ready",
          revision: 8,
        },
      }));
    const client = createDocumentSessionClient(request);

    await expect(client.readWorkflow("doc/legacy")).resolves.toEqual({
      workflow: {
        collaboration: null,
        documentId: "doc/legacy",
        readiness: "needs_review",
        revision: 7,
      },
    });
    await expect(client.readWorkflow("doc/collaborative")).resolves.toEqual({
      workflow: {
        collaboration: { generation: 3, headSeq: 11 },
        documentId: "doc/collaborative",
        readiness: "ready",
        revision: 8,
      },
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/documents/doc%2Flegacy/workflow",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("posts readiness and approval commands without inventing a collaboration head", async () => {
    const needsReview = {
      collaboration: null,
      documentId: "doc_1",
      readiness: "needs_review",
      revision: 4,
    } as const;
    const approved = {
      collaboration: { generation: 2, headSeq: 14 },
      documentId: "doc_1",
      readiness: "approved",
      revision: 5,
    } as const;
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ workflow: needsReview }))
      .mockResolvedValueOnce(jsonResponse({ workflow: approved }));
    const client = createDocumentSessionClient(request);

    await expect(client.updateWorkflow("doc_1", {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).resolves.toEqual({ workflow: needsReview });
    await expect(client.updateWorkflow("doc_1", {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 14,
    })).resolves.toEqual({ workflow: approved });

    expect(request).toHaveBeenNthCalledWith(1, "/api/documents/doc_1/workflow", expect.objectContaining({
      body: JSON.stringify({ expectedReadiness: "draft", nextReadiness: "needs_review" }),
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/documents/doc_1/workflow", expect.objectContaining({
      body: JSON.stringify({
        expectedReadiness: "ready",
        nextReadiness: "approved",
        observedHeadSeq: 14,
      }),
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    { collaboration: null, documentId: "other", readiness: "draft", revision: 0 },
    { collaboration: null, documentId: "doc_1", readiness: "invented", revision: 0 },
    { collaboration: null, documentId: "doc_1", readiness: "draft", revision: -1 },
    {
      collaboration: { generation: 0, headSeq: 1 },
      documentId: "doc_1",
      readiness: "draft",
      revision: 0,
    },
    {
      collaboration: { generation: 1, headSeq: Number.MAX_SAFE_INTEGER + 1 },
      documentId: "doc_1",
      readiness: "draft",
      revision: 0,
    },
  ])("rejects malformed or cross-document workflow success state: %o", async (workflow) => {
    const client = createDocumentSessionClient(
      vi.fn().mockResolvedValue(jsonResponse({ workflow })),
    );

    await expect(client.readWorkflow("doc_1")).rejects.toMatchObject({
      name: "DocumentWorkflowRequestError",
      reason: "malformed_response",
      status: 200,
    });
  });

  it.each([
    ["expected_readiness_conflict", 409],
    ["head_conflict", 409],
    ["forbidden", 403],
    ["not_found", 404],
    ["collaboration_unavailable", 503],
    ["workflow_unavailable", 503],
    ["legacy_approval_unsupported", 409],
  ] as const)("preserves the stable %s workflow error and authoritative recovery state", async (reason, status) => {
    const workflow = {
      collaboration: { generation: 2, headSeq: 17 },
      documentId: "doc_1",
      readiness: "needs_review",
      revision: 9,
    } as const;
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason,
      workflow,
    }, status)));

    const result = client.updateWorkflow("doc_1", {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 16,
    });
    await expect(result).rejects.toBeInstanceOf(DocumentWorkflowRequestError);
    await expect(result).rejects.toMatchObject({ reason, status, workflow });
  });

  it("parses a workflow Project Profile violation without coercing unknown values", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: {
        current: "draft",
        next: "ready",
        reason: "invalid_readiness_transition",
      },
    }, 400)));

    await expect(client.updateWorkflow("doc_1", {
      expectedReadiness: "draft",
      nextReadiness: "ready",
    })).rejects.toMatchObject({
      name: "DocumentWorkflowRequestError",
      reason: "invalid_project_profile",
      status: 400,
      violation: {
        current: "draft",
        next: "ready",
        reason: "invalid_readiness_transition",
      },
    });
  });

  it("bounds workflow requests and aborts the transport when the client deadline expires", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    });
    const client = createDocumentSessionClient(request);

    const result = expect(client.readWorkflow("doc_1", { timeoutMs: 50 })).rejects.toMatchObject({
      name: "DocumentWorkflowRequestError",
      reason: "timeout",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(observedSignal?.aborted).toBe(true);
    await result;
  });

  it("settles immediately on caller abort even when an injected transport ignores its signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const client = createDocumentSessionClient(vi.fn((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }));
    const result = expect(client.readWorkflow("doc_1", {
      signal: caller.signal,
      timeoutMs: 10_000,
    })).rejects.toMatchObject({
      name: "DocumentWorkflowRequestError",
      reason: "aborted",
      status: 0,
    });

    caller.abort();

    expect(transportSignal?.aborted).toBe(true);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the workflow deadline active while the response body is being consumed", async () => {
    vi.useFakeTimers();
    const response = jsonResponse({ workflow: {} });
    vi.spyOn(response, "json").mockImplementation(() => new Promise<never>(() => undefined));
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(response));
    const result = expect(client.readWorkflow("doc_1", { timeoutMs: 50 })).rejects.toMatchObject({
      name: "DocumentWorkflowRequestError",
      reason: "timeout",
      status: 0,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await result;
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

  it("returns a typed invalid-profile save result with the field violation", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: { fieldId: "owner", ok: false, reason: "required" },
    }, 400)));

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "invalid_profile",
      status: 400,
      violation: { fieldId: "owner", ok: false, reason: "required" },
    });
  });

  it("returns a generic save failure when the profile violation reason cannot be coerced", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: {
        fieldId: "owner",
        ok: false,
        reason: { toString: null, valueOf: null },
      },
    }, 400)));

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "failed",
      status: 400,
    });
  });

  it("rejects invalid readiness identifiers instead of casting them into a profile violation", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: {
        current: "draft",
        next: "not-a-readiness-state",
        reason: "invalid_readiness_transition",
      },
    }, 400)));

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "failed",
      status: 400,
    });
  });

  it("treats a successful invalid-profile-shaped body as a malformed success contract", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: { fieldId: "owner", ok: false, reason: "required" },
    })));

    await expect(client.save("doc_1", draft, 3)).resolves.toEqual({
      kind: "failed",
      status: 200,
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
  ])("throws a typed invalid-profile request error for %s", async (_name, requestChange) => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: { fieldId: "owner", ok: false, reason: "invalid_length" },
    }, 400)));

    const result = requestChange(client);
    await expect(result).rejects.toBeInstanceOf(DocumentSessionInvalidProfileError);
    await expect(result).rejects.toMatchObject({
      status: 400,
      violation: { fieldId: "owner", ok: false, reason: "invalid_length" },
    });
  });

  it("throws a generic request error when the profile violation reason cannot be coerced", async () => {
    const client = createDocumentSessionClient(vi.fn().mockResolvedValue(jsonResponse({
      reason: "invalid_project_profile",
      violation: {
        fieldId: "owner",
        ok: false,
        reason: { toString: null, valueOf: null },
      },
    }, 400)));

    const result = client.applyProposal("proposal_1", {
      appliedMode: "replace",
      document: { id: "doc_1", ...draft },
      expectedRevision: 3,
    });
    await expect(result).rejects.toBeInstanceOf(DocumentSessionRequestError);
    await expect(result).rejects.not.toBeInstanceOf(TypeError);
    await expect(result).rejects.toMatchObject({ status: 400 });
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
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).document).not.toHaveProperty("readiness");
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).document).not.toHaveProperty("readiness");
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
      body: JSON.stringify({
        title: draft.title,
        contentJson: draft.contentJson,
        metadataJson: draft.metadataJson,
      }),
    }));
  });
});
