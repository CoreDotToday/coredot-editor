import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDocumentChanges } from "@/features/documents/document-change-service";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET, OPTIONS } from "./route";

vi.mock("@/features/documents/document-change-service", () => ({
  listDocumentChanges: vi.fn(),
}));

describe("GET /api/document-changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("lists a scoped page of document changes", async () => {
    vi.mocked(listDocumentChanges).mockResolvedValueOnce({
      changes: [{
        id: "change_1",
        documentId: "doc_1",
        kind: "single",
        batchId: null,
        afterRevision: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        mode: "legacy",
        undoneAt: null,
        proposals: [{
          id: "proposal_1",
          targetText: "old",
          replacementText: "new",
          appliedMode: "replace",
          ordinal: 0,
        }],
      }],
      nextCursor: "change_1",
    });

    const response = await GET(new Request(
      "http://localhost/api/document-changes?documentId=doc_1&limit=2&cursor=change_0",
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changes: [{ id: "change_1", proposals: [{ id: "proposal_1", ordinal: 0 }] }],
      nextCursor: "change_1",
    });
    expect(listDocumentChanges).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      documentId: "doc_1",
      limit: 2,
      cursor: "change_0",
    });
  });

  it.each([
    "http://localhost/api/document-changes",
    "http://localhost/api/document-changes?documentId=doc_1&limit=0",
    "http://localhost/api/document-changes?documentId=doc_1&limit=51",
  ])("rejects invalid list parameters before querying history: %s", async (url) => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid query parameters" });
    expect(listDocumentChanges).not.toHaveBeenCalled();
  });

  it("advertises the protected read methods", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
