import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentsByIdsMock } = vi.hoisted(() => ({
  getDocumentsByIdsMock: vi.fn(),
}));

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentsByIds: getDocumentsByIdsMock,
}));

import { hydrateAiReferenceDocuments } from "./reference-hydration";

describe("hydrateAiReferenceDocuments", () => {
  beforeEach(() => {
    getDocumentsByIdsMock.mockReset();
  });

  it("deduplicates references and excludes the current document before server hydration", async () => {
    getDocumentsByIdsMock.mockResolvedValue([
      {
        id: "doc_ref",
        plainText: "Server reference text",
        title: "Server reference title",
      },
    ]);

    const result = await hydrateAiReferenceDocuments(
      {
        documents: [
          { documentId: "doc_current", titleSnapshot: "Client current title" },
          { documentId: "doc_ref", titleSnapshot: "Client stale title" },
          { documentId: "doc_ref", titleSnapshot: "Client duplicate title" },
        ],
      },
      { currentDocumentId: "doc_current" },
    );

    expect(getDocumentsByIdsMock).toHaveBeenCalledWith({ workspaceId: "local" }, ["doc_ref"]);
    expect(result).toEqual([
      {
        id: "doc_ref",
        text: "Server reference text",
        title: "Server reference title",
      },
    ]);
  });

  it("does not hit the repository when only self references remain", async () => {
    const result = await hydrateAiReferenceDocuments(
      {
        documents: [{ documentId: "doc_current", titleSnapshot: "Client current title" }],
      },
      { currentDocumentId: "doc_current" },
    );

    expect(getDocumentsByIdsMock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
