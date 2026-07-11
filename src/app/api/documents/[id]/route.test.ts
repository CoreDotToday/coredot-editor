import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveDocument, getDocumentById, updateDocumentContent } from "@/features/documents/document-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { DELETE, GET, PUT } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  archiveDocument: vi.fn(),
  getDocumentById: vi.fn(),
  updateDocumentContent: vi.fn(async (_scope, id, input) => ({
    id,
    ...input,
    plainText: "Updated body",
    status: "draft",
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
      }),
      { params: Promise.resolve({ id: "doc_1" }) },
    );

    expect(response.status).toBe(200);
    expect(updateDocumentContent).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "doc_1", {
      title: "Updated Memo",
      contentJson: { type: "doc", content: [] },
      readiness: "ready",
      metadataJson: { owner: "Legal", tags: ["risk"] },
    });
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
    expect(updateDocumentContent).not.toHaveBeenCalled();
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
    vi.mocked(updateDocumentContent).mockResolvedValueOnce(null as never);
    vi.mocked(archiveDocument).mockResolvedValueOnce(null as never);
    const params = { params: Promise.resolve({ id: "workspace-a-document" }) };

    const readResponse = await GET(new Request("http://localhost/api/documents/workspace-a-document"), params);
    const updateResponse = await PUT(
      createJsonRequest({ title: "Blocked", contentJson: { type: "doc", content: [] } }),
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
    expect(updateDocumentContent).toHaveBeenCalledWith(
      workspaceBContext,
      "workspace-a-document",
      expect.objectContaining({ title: "Blocked" }),
    );
    expect(archiveDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-a-document");
  });
});
