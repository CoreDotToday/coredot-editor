import type { DocumentReadiness } from "@/db/schema";

type FilterMetadataValue = boolean | number | readonly string[] | string | string[] | null;
type FilterMetadata = Record<string, FilterMetadataValue | undefined>;

type FilterableDocumentSummary = {
  metadataJson: FilterMetadata;
  plainText: string;
  readiness: DocumentReadiness;
  title: string;
};

export type DocumentSummaryFilters = {
  metadataKey?: string;
  metadataValue?: string;
  query?: string;
  readiness?: DocumentReadiness | "all";
};

export function filterDocumentSummaries<TDocument extends FilterableDocumentSummary>(
  documents: readonly TDocument[],
  filters: DocumentSummaryFilters,
) {
  const query = normalizeFilterText(filters.query);
  const metadataKey = filters.metadataKey?.trim();
  const metadataValue = normalizeFilterText(filters.metadataValue);

  return documents.filter((document) => {
    if (filters.readiness && filters.readiness !== "all" && document.readiness !== filters.readiness) {
      return false;
    }

    if (query && !`${document.title}\n${document.plainText}`.toLocaleLowerCase().includes(query)) {
      return false;
    }

    if (metadataKey && metadataValue) {
      return metadataMatches(document.metadataJson[metadataKey], metadataValue);
    }

    return true;
  });
}

function metadataMatches(value: FilterMetadataValue | undefined, query: string) {
  if (Array.isArray(value)) {
    return value.some((item) => item.toLocaleLowerCase().includes(query));
  }

  return String(value ?? "").toLocaleLowerCase().includes(query);
}

function normalizeFilterText(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? "";
}
