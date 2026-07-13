import type {
  DocumentMetadata,
  DocumentMetadataValue,
  DocumentReadiness,
} from "@/db/schema";

export type ProjectLocale = "en" | "ko";
export type ProjectMetadataFieldType = "boolean" | "date" | "number" | "select" | "tags" | "text";

export type ProjectMetadataField = {
  filterable?: boolean;
  id: string;
  itemMaxLength?: number;
  labels: Record<ProjectLocale, string>;
  maxItems?: number;
  maxLength?: number;
  options?: readonly string[];
  required?: boolean;
  type: ProjectMetadataFieldType;
};

export type ProjectReadinessState = {
  id: DocumentReadiness;
  labels: Record<ProjectLocale, string>;
  transitions: readonly DocumentReadiness[];
};

export type ProjectProfile = {
  defaultTemplateIds: readonly string[];
  id: string;
  labels: Record<ProjectLocale, { name: string }>;
  metadataFields: readonly ProjectMetadataField[];
  readiness: readonly ProjectReadinessState[];
};

export type DocumentFilterDefinition = Pick<ProjectMetadataField, "id" | "labels" | "options" | "type">;

export type ProjectMetadataValidationResult =
  | { ok: true; value: DocumentMetadata }
  | { fieldId: string; ok: false; reason: "invalid_length" | "invalid_option" | "invalid_type" | "required" | "unknown_field" };

export type ProjectProfileViolation =
  | Exclude<ProjectMetadataValidationResult, { ok: true }>
  | {
      current: DocumentReadiness;
      next: DocumentReadiness;
      reason: "invalid_readiness_transition";
    };

export type ProjectDocumentStateValidationResult =
  | {
      ok: true;
      value: { metadataJson: DocumentMetadata; readiness: DocumentReadiness };
    }
  | { ok: false; violation: ProjectProfileViolation };

export class ProjectProfileViolationError extends Error {
  override readonly name = "ProjectProfileViolationError";

  constructor(readonly violation: ProjectProfileViolation) {
    super("Document violates active Project Profile");
  }
}

export const PROJECT_METADATA_LIMITS = Object.freeze({
  maxTagCount: 32,
  maxTagLength: 64,
  maxTextLength: 2_000,
});

export function defineProjectProfile(profile: ProjectProfile): ProjectProfile {
  assertNonBlank(profile.id, "profile id", profile.id);
  assertNonBlank(profile.labels.en.name, "profile label", profile.id);
  assertNonBlank(profile.labels.ko.name, "profile label", profile.id);

  const defaultTemplateIds = new Set(profile.defaultTemplateIds);
  if (defaultTemplateIds.size !== profile.defaultTemplateIds.length) {
    throw new Error(`Project Profile ${profile.id} has duplicate default templates`);
  }
  for (const templateId of profile.defaultTemplateIds) {
    assertNonBlank(templateId, "default template id", profile.id);
  }

  if (profile.readiness.length === 0) {
    throw new Error(`Project Profile ${profile.id} must define readiness states`);
  }
  if (profile.readiness[0]?.id !== "draft") {
    throw new Error(`Project Profile ${profile.id} initial readiness state must be draft`);
  }
  const readinessIds = new Set(profile.readiness.map((state) => state.id));
  if (readinessIds.size !== profile.readiness.length) {
    throw new Error(`Project Profile ${profile.id} has duplicate readiness states`);
  }
  for (const state of profile.readiness) {
    assertNonBlank(state.id, "readiness state id", profile.id);
    assertNonBlank(state.labels.en, "readiness state label", profile.id);
    assertNonBlank(state.labels.ko, "readiness state label", profile.id);
    if (new Set(state.transitions).size !== state.transitions.length) {
      throw new Error(`Project Profile ${profile.id} has duplicate readiness transitions for ${state.id}`);
    }
    for (const transition of state.transitions) {
      if (!readinessIds.has(transition)) {
        throw new Error(`Project Profile ${profile.id} has an unknown readiness transition: ${transition}`);
      }
    }
  }

  const metadataIds = new Set(profile.metadataFields.map((field) => field.id));
  if (metadataIds.size !== profile.metadataFields.length) {
    throw new Error(`Project Profile ${profile.id} has duplicate metadata fields`);
  }

  for (const field of profile.metadataFields) {
    assertNonBlank(field.id, "metadata field id", profile.id);
    assertNonBlank(field.labels.en, "metadata field label", profile.id);
    assertNonBlank(field.labels.ko, "metadata field label", profile.id);
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      throw new Error(`Project Profile ${profile.id} select field ${field.id} must define options`);
    }
    if (field.type !== "select" && field.options !== undefined) {
      throw new Error(`Project Profile ${profile.id} non-select field ${field.id} cannot define options`);
    }
    if (field.options) {
      for (const option of field.options) {
        assertNonBlank(option, "metadata field option", profile.id);
      }
      if (new Set(field.options).size !== field.options.length) {
        throw new Error(`Project Profile ${profile.id} field ${field.id} has duplicate options`);
      }
    }
    validateMetadataFieldCaps(profile.id, field);
  }

  return deepFreeze(cloneProjectProfile(profile));
}

export function createDocumentFilterDefinitions(profile: ProjectProfile): DocumentFilterDefinition[] {
  return profile.metadataFields
    .filter((field) => field.filterable)
    .map(({ id, labels, options, type }) => ({ id, labels, options, type }));
}

export function getProjectReadinessOptions(profile: ProjectProfile, current: DocumentReadiness) {
  const currentState = profile.readiness.find((state) => state.id === current);
  if (!currentState) return [];
  const allowed = new Set<DocumentReadiness>([current, ...currentState.transitions]);
  return profile.readiness.filter((state) => allowed.has(state.id));
}

export function isProjectReadinessTransitionAllowed(
  profile: ProjectProfile,
  current: DocumentReadiness,
  next: DocumentReadiness,
) {
  return getProjectReadinessOptions(profile, current).some((state) => state.id === next);
}

export function validateProjectDocumentState(
  profile: ProjectProfile,
  input: { metadataJson: DocumentMetadata; readiness: DocumentReadiness },
  previous?: { metadataJson: DocumentMetadata; readiness: DocumentReadiness },
): ProjectDocumentStateValidationResult {
  const enforceRequired = input.readiness !== "draft";
  const metadataResult = validateProjectMetadata(
    profile,
    input.metadataJson,
    previous?.metadataJson,
    { enforceRequired },
  );
  if (!metadataResult.ok) return { ok: false, violation: metadataResult };

  const currentReadiness = previous?.readiness ?? profile.readiness[0]!.id;
  if (!isProjectReadinessTransitionAllowed(profile, currentReadiness, input.readiness)) {
    return {
      ok: false,
      violation: {
        current: currentReadiness,
        next: input.readiness,
        reason: "invalid_readiness_transition",
      },
    };
  }

  return {
    ok: true,
    value: { metadataJson: metadataResult.value, readiness: input.readiness },
  };
}

export function validateProjectMetadata(
  profile: ProjectProfile,
  input: DocumentMetadata,
  previous: DocumentMetadata = {},
  options: { enforceRequired?: boolean } = {},
): ProjectMetadataValidationResult {
  const fields = new Map(profile.metadataFields.map((field) => [field.id, field]));
  const value: DocumentMetadata = {};

  for (const [id, legacyValue] of Object.entries(previous)) {
    if (!fields.has(id)) value[id] = legacyValue;
  }

  for (const [id, candidate] of Object.entries(input)) {
    const field = fields.get(id);
    if (!field) {
      if (!(id in previous) || !metadataValuesEqual(previous[id], candidate)) {
        return { fieldId: id, ok: false, reason: "unknown_field" };
      }
      value[id] = previous[id]!;
      continue;
    }

    const normalized = normalizeFieldValue(field, candidate);
    if (!normalized.ok) return { fieldId: id, ok: false, reason: normalized.reason };
    if (normalized.value !== undefined) value[id] = normalized.value;
  }

  for (const field of profile.metadataFields) {
    if (options.enforceRequired !== false && field.required && value[field.id] === undefined) {
      return { fieldId: field.id, ok: false, reason: "required" };
    }
  }

  return { ok: true, value };
}

function normalizeFieldValue(
  field: ProjectMetadataField,
  candidate: DocumentMetadataValue,
): { ok: true; value: DocumentMetadataValue | undefined } | { ok: false; reason: "invalid_length" | "invalid_option" | "invalid_type" } {
  if (candidate === null || candidate === "") return { ok: true, value: undefined };
  if (field.type === "boolean") {
    return typeof candidate === "boolean" ? { ok: true, value: candidate } : { ok: false, reason: "invalid_type" };
  }
  if (field.type === "number") {
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? { ok: true, value: candidate }
      : { ok: false, reason: "invalid_type" };
  }
  if (field.type === "tags") {
    if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string")) {
      return { ok: false, reason: "invalid_type" };
    }
    const tags = candidate.map((item) => item.trim()).filter(Boolean);
    const limits = getProjectMetadataFieldLimits(field);
    if (tags.length > limits.maxItems! || tags.some((tag) => tag.length > limits.itemMaxLength!)) {
      return { ok: false, reason: "invalid_length" };
    }
    return { ok: true, value: tags.length === 0 ? undefined : tags };
  }
  if (typeof candidate !== "string") return { ok: false, reason: "invalid_type" };
  const normalized = candidate.trim();
  if (!normalized) return { ok: true, value: undefined };
  if (field.type === "text" && normalized.length > getProjectMetadataFieldLimits(field).maxLength!) {
    return { ok: false, reason: "invalid_length" };
  }
  if (field.type === "date" && !isCalendarDate(normalized)) {
    return { ok: false, reason: "invalid_type" };
  }
  if (field.type === "select" && !field.options?.includes(normalized)) {
    return { ok: false, reason: "invalid_option" };
  }
  return { ok: true, value: normalized };
}

export function getProjectMetadataFieldLimits(field: ProjectMetadataField): {
  itemMaxLength?: number;
  maxItems?: number;
  maxLength?: number;
} {
  if (field.type === "text") {
    return { maxLength: field.maxLength ?? PROJECT_METADATA_LIMITS.maxTextLength };
  }
  if (field.type === "tags") {
    return {
      itemMaxLength: field.itemMaxLength ?? PROJECT_METADATA_LIMITS.maxTagLength,
      maxItems: field.maxItems ?? PROJECT_METADATA_LIMITS.maxTagCount,
    };
  }
  return {};
}

function validateMetadataFieldCaps(profileId: string, field: ProjectMetadataField) {
  if (field.type === "text") {
    assertMetadataFieldLimit(profileId, field.id, "maxLength", field.maxLength, PROJECT_METADATA_LIMITS.maxTextLength);
    if (field.maxItems !== undefined || field.itemMaxLength !== undefined) {
      throw new Error(`Project Profile ${profileId} text field ${field.id} cannot define tag limits`);
    }
    return;
  }
  if (field.type === "tags") {
    assertMetadataFieldLimit(profileId, field.id, "maxItems", field.maxItems, PROJECT_METADATA_LIMITS.maxTagCount);
    assertMetadataFieldLimit(
      profileId,
      field.id,
      "itemMaxLength",
      field.itemMaxLength,
      PROJECT_METADATA_LIMITS.maxTagLength,
    );
    if (field.maxLength !== undefined) {
      throw new Error(`Project Profile ${profileId} tags field ${field.id} cannot define maxLength`);
    }
    return;
  }
  if (field.maxLength !== undefined || field.maxItems !== undefined || field.itemMaxLength !== undefined) {
    throw new Error(`Project Profile ${profileId} ${field.type} field ${field.id} cannot define length limits`);
  }
}

function assertMetadataFieldLimit(
  profileId: string,
  fieldId: string,
  name: string,
  value: number | undefined,
  maximum: number,
) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`Project Profile ${profileId} field ${fieldId} has invalid ${name}`);
  }
}

function assertNonBlank(value: string, subject: string, profileId: string) {
  if (!value.trim()) throw new Error(`Project Profile ${profileId} has an empty ${subject}`);
}

function cloneProjectProfile(profile: ProjectProfile): ProjectProfile {
  return {
    defaultTemplateIds: [...profile.defaultTemplateIds],
    id: profile.id,
    labels: {
      en: { ...profile.labels.en },
      ko: { ...profile.labels.ko },
    },
    metadataFields: profile.metadataFields.map((field) => ({
      ...field,
      labels: { ...field.labels },
      options: field.options ? [...field.options] : undefined,
    })),
    readiness: profile.readiness.map((state) => ({
      ...state,
      labels: { ...state.labels },
      transitions: [...state.transitions],
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function metadataValuesEqual(left: DocumentMetadataValue | undefined, right: DocumentMetadataValue) {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((item, index) => item === right[index])
    : left === right;
}
