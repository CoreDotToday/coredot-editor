import { describe, expect, it } from "vitest";
import { filterDocumentSummaries } from "./document-filters";
import { parseDocumentSummaryFilters } from "./document-filters";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { defineProjectProfile } from "@/features/projects/project-profile";

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

  it("accepts only filterable metadata and readiness declared by the active profile", () => {
    const profile = getProjectProfile("legal-review");

    expect(parseDocumentSummaryFilters(profile, {
      metadataKey: "counterparty",
      metadataValue: "Core Dot",
      readiness: "needs_review",
    })).toEqual({
      metadataKey: "counterparty",
      metadataValue: "Core Dot",
      query: undefined,
      readiness: "needs_review",
    });
    expect(() => parseDocumentSummaryFilters(profile, {
      metadataKey: "researchQuestion",
      metadataValue: "secret",
    })).toThrow("Invalid document summary filter");
    expect(() => parseDocumentSummaryFilters(profile, { readiness: "unknown" }))
      .toThrow("Invalid document summary filter");
  });

  it("normalizes typed filter values from the same profile field definitions", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "typed-filter",
      labels: { en: { name: "Typed" }, ko: { name: "타입" } },
      metadataFields: [
        { filterable: true, id: "billable", labels: { en: "Billable", ko: "청구" }, type: "boolean" },
        { filterable: true, id: "score", labels: { en: "Score", ko: "점수" }, type: "number" },
        { filterable: true, id: "stage", labels: { en: "Stage", ko: "단계" }, options: ["open", "closed"], type: "select" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });

    expect(parseDocumentSummaryFilters(profile, { metadataKey: "billable", metadataValue: "true" }))
      .toMatchObject({ metadataKey: "billable", metadataValue: "true" });
    expect(parseDocumentSummaryFilters(profile, { metadataKey: "score", metadataValue: "01.50" }))
      .toMatchObject({ metadataKey: "score", metadataValue: "1.5" });
    expect(() => parseDocumentSummaryFilters(profile, { metadataKey: "stage", metadataValue: "missing" }))
      .toThrow("Invalid document summary filter");
    expect(() => parseDocumentSummaryFilters(profile, { metadataKey: "stage" }))
      .toThrow("Invalid document summary filter");
  });
});
