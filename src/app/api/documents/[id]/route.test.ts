import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveDocument, getDocumentById, saveDocumentDraft } from "@/features/documents/document-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { DELETE, GET, PUT } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  archiveDocument: vi.fn(),
  getDocumentById: vi.fn(),
  saveDocumentDraft: vi.fn(async (_scope, id, input) => ({
    status: "success",
    document: {
      id,
      ...input,
      revision: input.expectedRevision + 1,
      plainText: "Updated body",
      status: "draft",
    },
  })),
}));

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/documents/doc_1", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("PUT /api/documents/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("passes readiness and metadata through to document updates", async () => {
    const response = await PUT(
      createJsonRequest({
        title: "Updated Memo",
        contentJson: { type: "doc", content: [] },
        readiness: "ready",
        metadataJson: { owner: "Legal", tags: ["risk"] },
        expectedRevision: 3,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    expect(saveDocumentDraft).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "doc_1", {
      title: "Updated Memo",
      contentJson: { type: "doc", content: [] },
      readiness: "ready",
      metadataJson: { owner: "Legal", tags: ["risk"] },
      expectedRevision: 3,
    });
  });

  it("does not expose an internal creation key on direct reads", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      id: "doc_1",
      workspaceId: "vitest-workspace",
      creationKey: "internal-recovery-key-123456",
      title: "Draft",
      contentJson: { type: "doc" },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      revision: 0,
      status: "draft",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await GET(
      new Request("http://localhost/api/documents/doc_1"),
      { params: Promise.resolve({ id: "doc_1" }) },
    );
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(responseBody.document).not.toHaveProperty("creationKey");
  });

  it("rejects oversized document update bodies before JSON parsing or persistence", async () => {
    const json = vi.fn();
    const request = {
      headers: new Headers({ "content-length": String(RESOURCE_LIMITS.documentJsonBytes + 1024 * 1024 + 1) }),
      json,
    } as unknown as Request;

    const response = await PUT(request, { params: Promise.resolve({ id: "doc_1" }) });

    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(saveDocumentDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 0.5],
  ])("returns 400 when expectedRevision is %s", async (_label, expectedRevision) => {
    const response = await PUT(
      createJsonRequest({
        title: "Updated Memo",
        contentJson: { type: "doc", content: [] },
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(400);
    expect(saveDocumentDraft).not.toHaveBeenCalled();
  });

  it("returns a stable 409 conflict response with the latest document", async () => {
    vi.mocked(saveDocumentDraft).mockResolvedValueOnce({
      status: "revision_conflict",
      latest: { id: "doc_1", title: "Newer", revision: 4 },
    } as never);

    const response = await PUT(
      createJsonRequest({
        title: "Stale",
        contentJson: { type: "doc", content: [] },
        expectedRevision: 3,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Document revision conflict",
      reason: "revision_conflict",
      document: { id: "doc_1", title: "Newer", revision: 4 },
    });
  });

  it("returns 400 when the persistence boundary rejects a Project Profile transition", async () => {
    vi.mocked(saveDocumentDraft).mockResolvedValueOnce({
      status: "invalid_profile",
      violation: {
        current: "draft",
        next: "approved",
        reason: "invalid_readiness_transition",
      },
    } as never);

    const response = await PUT(
      createJsonRequest({
        title: "Skip review",
        contentJson: { type: "doc", content: [] },
        readiness: "approved",
        expectedRevision: 0,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

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

  it("returns 404 for direct reads and mutations of another workspace's document", async () => {
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
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as never);
    vi.mocked(saveDocumentDraft).mockResolvedValueOnce({ status: "not_found" } as never);
    vi.mocked(archiveDocument).mockResolvedValueOnce(null as never);
    const params = { params: Promise.resolve({ id: "workspace-a-document" }) };

    const readResponse = await GET(new Request("http://localhost/api/documents/workspace-a-document"), params);
    const updateResponse = await PUT(
      createJsonRequest({ title: "Blocked", contentJson: { type: "doc", content: [] }, expectedRevision: 0 }),
      params,
    );
    const archiveResponse = await DELETE(
      new Request("http://localhost/api/documents/workspace-a-document", { method: "DELETE" }),
      params,
    );

    expect(readResponse.status).toBe(404);
    expect(updateResponse.status).toBe(404);
    expect(archiveResponse.status).toBe(404);
    expect(getDocumentById).toHaveBeenCalledWith(workspaceBContext, "workspace-a-document");
    expect(saveDocumentDraft).toHaveBeenCalledWith(
      workspaceBContext,
      "workspace-a-document",
      expect.objectContaining({ title: "Blocked" }),
    );
    expect(archiveDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-a-document");
  });
});
