import type { DocumentMetadata, DocumentMetadataValue, DocumentReadiness } from "@/db/schema";

export const documentReadinessValues = ["draft", "needs_review", "ready", "approved"] as const satisfies readonly DocumentReadiness[];

export function normalizeDocumentReadiness(value: unknown): DocumentReadiness {
  return documentReadinessValues.includes(value as DocumentReadiness) ? (value as DocumentReadiness) : "draft";
}

export function normalizeDocumentMetadata(value: unknown): DocumentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce<DocumentMetadata>((metadata, [key, rawValue]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.startsWith("_")) {
      return metadata;
    }

    const normalizedValue = normalizeDocumentMetadataValue(rawValue);
    if (normalizedValue !== undefined) {
      metadata[normalizedKey] = normalizedValue;
    }

    return metadata;
  }, {});
}

function normalizeDocumentMetadataValue(value: unknown): DocumentMetadataValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}
