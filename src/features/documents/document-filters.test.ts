import { describe, expect, it } from "vitest";
import { filterDocumentSummaries } from "./document-filters";

const documents = [
  {
    id: "doc_1",
    metadataJson: { owner: "Legal", tags: ["msa", "risk"] },
    plainText: "Revenue terms",
    readiness: "needs_review",
    title: "Contract Memo",
  },
  {
    id: "doc_2",
    metadataJson: { owner: "Finance" },
    plainText: "Board narrative",
    readiness: "ready",
    title: "Board Brief",
  },
] as const;

describe("filterDocumentSummaries", () => {
  it("filters by search text and readiness", () => {
    expect(filterDocumentSummaries(documents, { query: "contract", readiness: "needs_review" }).map((doc) => doc.id))
      .toEqual(["doc_1"]);
  });

  it("filters by metadata key/value", () => {
    expect(filterDocumentSummaries(documents, { metadataKey: "owner", metadataValue: "finance" }).map((doc) => doc.id))
      .toEqual(["doc_2"]);
    expect(filterDocumentSummaries(documents, { metadataKey: "tags", metadataValue: "risk" }).map((doc) => doc.id))
      .toEqual(["doc_1"]);
  });
});
