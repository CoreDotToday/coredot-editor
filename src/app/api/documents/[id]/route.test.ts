import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateDocumentContent } from "@/features/documents/document-repository";
import { PUT } from "./route";

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
    expect(updateDocumentContent).toHaveBeenCalledWith({ workspaceId: "local" }, "doc_1", {
      title: "Updated Memo",
      contentJson: { type: "doc", content: [] },
      readiness: "ready",
      metadataJson: { owner: "Legal", tags: ["risk"] },
    });
  });
});
