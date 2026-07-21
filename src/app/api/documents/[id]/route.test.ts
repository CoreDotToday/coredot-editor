import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveDocumentWithRoomClosure } from "@/features/documents/document-archive-command";
import { DocumentArchiveServiceError } from "@/features/documents/document-archive-service";
import { getDocumentById, saveDocumentDraft } from "@/features/documents/document-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { DELETE, GET, PUT } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
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

vi.mock("@/features/documents/document-archive-command", () => ({
  archiveDocumentWithRoomClosure: vi.fn(),
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

  it("passes legacy document fields without granting the save payload workflow authority", async () => {
    const response = await PUT(
      createJsonRequest({
        title: "Updated Memo",
        contentJson: { type: "doc", content: [] },
        metadataJson: { owner: "Legal", tags: ["risk"] },
        expectedRevision: 3,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    expect(saveDocumentDraft).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "doc_1", {
      title: "Updated Memo",
      contentJson: { type: "doc", content: [] },
      metadataJson: { owner: "Legal", tags: ["risk"] },
      expectedRevision: 3,
    });
  });

  it("rejects a legacy save payload that attempts to own workflow readiness", async () => {
    const response = await PUT(
      createJsonRequest({
        title: "Workflow smuggling",
        contentJson: { type: "doc", content: [] },
        readiness: "approved",
        expectedRevision: 3,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(400);
    expect(saveDocumentDraft).not.toHaveBeenCalled();
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

  it("returns a bounded 409 when collaboration already owns the document draft", async () => {
    vi.mocked(saveDocumentDraft).mockResolvedValueOnce({
      status: "collaboration_initialized",
    } as never);

    const response = await PUT(
      createJsonRequest({
        title: "Legacy overwrite",
        contentJson: { type: "doc", content: [] },
        expectedRevision: 0,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Document collaboration is already initialized",
      reason: "collaboration_initialized",
    });
  });

  it("returns 400 when the persistence boundary rejects a Project Profile transition", async () => {
    vi.mocked(saveDocumentDraft).mockResolvedValueOnce({
      status: "invalid_profile",
      violation: {
        fieldId: "owner",
        ok: false,
        reason: "required",
      },
    } as never);

    const response = await PUT(
      createJsonRequest({
        title: "Missing required metadata",
        contentJson: { type: "doc", content: [] },
        expectedRevision: 0,
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: {
        fieldId: "owner",
        ok: false,
        reason: "required",
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
    vi.mocked(archiveDocumentWithRoomClosure).mockResolvedValueOnce({ status: "not_found" });
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
    expect(archiveDocumentWithRoomClosure).toHaveBeenCalledWith(
      workspaceBContext,
      "workspace-a-document",
    );
  });

  it.each([
    ["archived", "pending"],
    ["already_archived", "not_required"],
  ] as const)("returns a bounded success for %s documents", async (status, roomClosure) => {
    vi.mocked(archiveDocumentWithRoomClosure).mockResolvedValueOnce({ roomClosure, status });

    const response = await DELETE(
      new Request("http://localhost/api/documents/doc_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, roomClosure });
  });

  it("maps invalid archive input to a bounded 400", async () => {
    vi.mocked(archiveDocumentWithRoomClosure).mockRejectedValueOnce(
      new DocumentArchiveServiceError("invalid_input"),
    );

    const response = await DELETE(
      new Request("http://localhost/api/documents/invalid", { method: "DELETE" }),
      { params: Promise.resolve({ id: " invalid " }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid archive request",
      reason: "invalid_input",
    });
  });

  it("maps unavailable archive storage to a retryable bounded 503", async () => {
    vi.mocked(archiveDocumentWithRoomClosure).mockRejectedValueOnce(
      new DocumentArchiveServiceError("unavailable"),
    );

    const response = await DELETE(
      new Request("http://localhost/api/documents/doc_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Document archive service is unavailable",
      reason: "archive_unavailable",
    });
  });
});
