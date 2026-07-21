import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAiReferenceProjectionsByIdsMock } = vi.hoisted(() => ({
  getAiReferenceProjectionsByIdsMock: vi.fn(),
}));

vi.mock("./reference-projection-repository", () => ({
  getAiReferenceProjectionsByIds: getAiReferenceProjectionsByIdsMock,
}));

import { hydrateAiReferenceDocuments } from "./reference-hydration";

const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

describe("hydrateAiReferenceDocuments", () => {
  beforeEach(() => {
    getAiReferenceProjectionsByIdsMock.mockReset();
  });

  it("deduplicates references and excludes the current document before server hydration", async () => {
    getAiReferenceProjectionsByIdsMock.mockResolvedValue([
      {
        generation: null,
        headSeq: null,
        id: "doc_ref",
        plainText: "Server reference text",
        projectedSeq: null,
        title: "Server reference title",
      },
    ]);

    const result = await hydrateAiReferenceDocuments(
      workspaceA,
      {
        documents: [
          { documentId: "doc_current", titleSnapshot: "Client current title" },
          { documentId: "doc_ref", titleSnapshot: "Client stale title" },
          { documentId: "doc_ref", titleSnapshot: "Client duplicate title" },
        ],
      },
      { currentDocumentId: "doc_current" },
    );

    expect(getAiReferenceProjectionsByIdsMock).toHaveBeenCalledWith(workspaceA, ["doc_ref"]);
    expect(result).toEqual([
      {
        generation: null,
        id: "doc_ref",
        projectedSeq: null,
        text: "Server reference text",
        title: "Server reference title",
      },
    ]);
  });

  it("does not hit the repository when only self references remain", async () => {
    const result = await hydrateAiReferenceDocuments(
      workspaceB,
      {
        documents: [{ documentId: "doc_current", titleSnapshot: "Client current title" }],
      },
      { currentDocumentId: "doc_current" },
    );

    expect(getAiReferenceProjectionsByIdsMock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns current and stale fenced projection diagnostics without adding head state to provider data", async () => {
    getAiReferenceProjectionsByIdsMock.mockResolvedValue([
      {
        generation: 2,
        headSeq: 8,
        id: "doc_current_projection",
        plainText: "At head",
        projectedSeq: 8,
        title: "Current projection",
      },
      {
        generation: 5,
        headSeq: 21,
        id: "doc_stale_projection",
        plainText: "Fenced SQL projection",
        projectedSeq: 19,
        title: "Stale projection",
      },
    ]);

    const result = await hydrateAiReferenceDocuments(workspaceA, {
      documents: [
        { documentId: "doc_current_projection", titleSnapshot: "Browser current" },
        { documentId: "doc_stale_projection", titleSnapshot: "Browser stale" },
      ],
    });

    expect(result).toEqual([
      {
        generation: 2,
        id: "doc_current_projection",
        projectedSeq: 8,
        text: "At head",
        title: "Current projection",
      },
      {
        generation: 5,
        id: "doc_stale_projection",
        projectedSeq: 19,
        text: "Fenced SQL projection",
        title: "Stale projection",
      },
    ]);
  });

  it.each([
    { diagnostics: { generation: 1, headSeq: 2, projectedSeq: 3 }, label: "projection ahead of head" },
    { diagnostics: { generation: null, headSeq: 0, projectedSeq: null }, label: "partial legacy diagnostics" },
    { diagnostics: { generation: 0, headSeq: 0, projectedSeq: 0 }, label: "invalid generation" },
  ])("fails closed on corrupt collaboration projection diagnostics: $label", async ({ diagnostics }) => {
    getAiReferenceProjectionsByIdsMock.mockResolvedValue([{
      ...diagnostics,
      id: "doc_corrupt",
      plainText: "Must not hydrate",
      title: "Corrupt",
    }]);

    await expect(hydrateAiReferenceDocuments(workspaceA, {
      documents: [{ documentId: "doc_corrupt", titleSnapshot: "Browser" }],
    })).rejects.toThrow("AI reference projection is corrupt");
  });
});
