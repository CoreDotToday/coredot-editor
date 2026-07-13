import type { DocumentReadiness } from "@/db/schema";
import { createDocumentFilterDefinitions, type ProjectProfile } from "@/features/projects/project-profile";

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

export class InvalidDocumentSummaryFilterError extends Error {
  constructor() {
    super("Invalid document summary filter");
    this.name = "InvalidDocumentSummaryFilterError";
  }
}

export function parseDocumentSummaryFilters(
  profile: ProjectProfile,
  input: Record<string, string | undefined>,
): DocumentSummaryFilters {
  const metadataKey = input.metadataKey?.trim();
  const metadataDefinition = metadataKey
    ? createDocumentFilterDefinitions(profile).find((filter) => filter.id === metadataKey)
    : undefined;
  const hasMetadataValue = Boolean(input.metadataValue?.trim());
  if ((metadataKey && !metadataDefinition) || Boolean(metadataKey) !== hasMetadataValue) {
    throw new InvalidDocumentSummaryFilterError();
  }
  const metadataValue = metadataDefinition
    ? normalizeMetadataFilterValue(metadataDefinition, input.metadataValue)
    : undefined;
  if (metadataDefinition && metadataValue === undefined) {
    throw new InvalidDocumentSummaryFilterError();
  }
  const requestedReadiness = input.readiness?.trim();
  if (requestedReadiness && requestedReadiness !== "all" && !profile.readiness.some((state) => state.id === requestedReadiness)) {
    throw new InvalidDocumentSummaryFilterError();
  }
  const readiness = requestedReadiness && requestedReadiness !== "all"
    ? requestedReadiness as DocumentReadiness
    : "all";

  return {
    ...(metadataKey && metadataValue !== undefined
      ? { metadataKey, metadataValue }
      : {}),
    query: input.query?.trim() || undefined,
    readiness,
  };
}

function normalizeMetadataFilterValue(
  definition: ReturnType<typeof createDocumentFilterDefinitions>[number],
  value: string | undefined,
) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (definition.type === "boolean") {
    return normalized === "true" || normalized === "false" ? normalized : undefined;
  }
  if (definition.type === "number") {
    const number = Number(normalized);
    return Number.isFinite(number) ? String(number) : undefined;
  }
  if (definition.type === "select") {
    return definition.options?.includes(normalized) ? normalized : undefined;
  }
  if (definition.type === "date") {
    const date = new Date(`${normalized}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === normalized
      ? normalized
      : undefined;
  }
  return normalized;
}

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
