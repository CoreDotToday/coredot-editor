"use client";

import { useId, useState } from "react";
import type { DocumentMetadata, DocumentMetadataValue, DocumentReadiness } from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import {
  getProjectMetadataFieldLimits,
  getProjectReadinessOptions,
  type ProjectLocale,
  type ProjectMetadataField,
  type ProjectProfile,
} from "@/features/projects/project-profile";

type DocumentMetadataPanelProps = {
  language?: ProjectLocale;
  metadata: DocumentMetadata;
  metadataDisabled?: boolean;
  metadataDraftIdentity?: object;
  messages?: DocumentMetadataPanelMessages;
  onMetadataFieldChange: (key: string, value: DocumentMetadataValue | undefined) => void;
  onReadinessChange: (next: DocumentReadiness) => void;
  profile?: ProjectProfile;
  readiness: DocumentReadiness;
  readinessDescription?: string;
  readinessDisabled?: boolean;
};

export type DocumentMetadataPanelMessages = {
  category: string;
  dueDate: string;
  owner: string;
  readiness: string;
  readinessServerAuthority: string;
  readinessLabels: Record<DocumentReadiness, string>;
  tags: string;
  title: string;
};

const defaultMessages: DocumentMetadataPanelMessages = {
  category: "분류",
  dueDate: "기한",
  owner: "소유자",
  readiness: "준비 상태",
  readinessServerAuthority: "준비 상태와 승인은 서버에서 검증되며 공동 편집 문서에 기록되지 않습니다.",
  readinessLabels: {
    approved: "승인됨",
    draft: "초안",
    needs_review: "검토 필요",
    ready: "준비 완료",
  },
  tags: "태그",
  title: "속성",
};

export function DocumentMetadataPanel({
  language = "ko",
  metadata,
  metadataDisabled = false,
  metadataDraftIdentity,
  messages = defaultMessages,
  onMetadataFieldChange,
  onReadinessChange,
  profile = getProjectProfile("default"),
  readiness,
  readinessDescription,
  readinessDisabled = false,
}: DocumentMetadataPanelProps) {
  const readinessDescriptionId = useId();
  const readinessOptions = getProjectReadinessOptions(profile, readiness);

  const updateMetadata = (key: string, value: DocumentMetadataValue | undefined) => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      onMetadataFieldChange(key, undefined);
    } else {
      onMetadataFieldChange(key, value);
    }
  };

  return (
    <section className="shrink-0 border-t border-zinc-200 px-4 py-4">
      <h2 className="text-sm font-semibold text-zinc-950">{messages.title}</h2>
      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-zinc-500">{messages.readiness}</span>
          <select
            aria-label={messages.readiness}
            aria-describedby={readinessDescription ? readinessDescriptionId : undefined}
            className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
            disabled={readinessDisabled}
            onChange={(event) => onReadinessChange(event.currentTarget.value as DocumentReadiness)}
            value={readiness}
          >
            {readinessOptions.map((state) => (
              <option key={state.id} value={state.id}>
                {state.labels[language] ?? messages.readinessLabels[state.id]}
              </option>
            ))}
          </select>
          {readinessDescription ? (
            <span className="mt-1 block text-xs leading-5 text-zinc-500" id={readinessDescriptionId}>
              {readinessDescription}
            </span>
          ) : null}
        </label>
        {profile.metadataFields.map((field) => (
          <MetadataFieldInput
            field={field}
            disabled={metadataDisabled}
            key={`${profile.id}:${field.id}:${field.type}:${metadataDisabled ? "disabled" : "enabled"}`}
            label={field.labels[language]}
            language={language}
            metadataDraftIdentity={metadataDraftIdentity ?? profile}
            onChange={(value) => updateMetadata(field.id, value)}
            value={metadata[field.id]}
          />
        ))}
      </div>
    </section>
  );
}

function MetadataFieldInput({
  disabled,
  field,
  label,
  language,
  metadataDraftIdentity,
  onChange,
  value,
}: {
  disabled: boolean;
  field: ProjectMetadataField;
  label: string;
  language: ProjectLocale;
  metadataDraftIdentity: object;
  onChange: (value: DocumentMetadataValue | undefined) => void;
  value: DocumentMetadata[string];
}) {
  const hint = getMetadataFieldHint(field, language);
  const hintId = hint ? `metadata-field-${field.id}-hint` : undefined;
  const canonicalStringValue = field.type === "tags"
    ? Array.isArray(value) ? value.join(", ") : getStringMetadata(value)
    : getStringMetadata(value);
  const supportsRawDraft = field.type === "tags" || field.type === "text";
  const [inputState, setInputState] = useState<MetadataInputState>(() => ({
    draft: null,
    identity: metadataDraftIdentity,
    observedCanonical: canonicalStringValue,
  }));
  let currentInputState = inputState;
  if (inputState.identity !== metadataDraftIdentity) {
    currentInputState = {
      draft: null,
      identity: metadataDraftIdentity,
      observedCanonical: canonicalStringValue,
    };
    setInputState(currentInputState);
  } else if (inputState.observedCanonical !== canonicalStringValue) {
    const reconciledDraft = reconcileMetadataDraft(inputState.draft, canonicalStringValue);
    currentInputState = {
      draft: reconciledDraft,
      identity: metadataDraftIdentity,
      observedCanonical: canonicalStringValue,
    };
    setInputState(currentInputState);
  }
  const draft = currentInputState.draft;
  const draftMatchesCanonical = canDisplayMetadataDraft(draft, canonicalStringValue);

  if (field.type === "boolean") {
    return (
      <label className="block">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <select
          aria-label={label}
          aria-describedby={hintId}
          aria-required={field.required || undefined}
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          disabled={disabled}
          onChange={(event) => onChange(
            event.currentTarget.value === ""
              ? undefined
              : event.currentTarget.value === "true",
          )}
          required={field.required}
          value={value === true ? "true" : value === false ? "false" : ""}
        >
          <option value="">{language === "ko" ? "선택" : "Select"}</option>
          <option value="true">{language === "ko" ? "예" : "Yes"}</option>
          <option value="false">{language === "ko" ? "아니요" : "No"}</option>
        </select>
        {hint ? <span className="mt-1 block text-xs text-zinc-400" id={hintId}>{hint}</span> : null}
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label className="block">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <input
          aria-label={label}
          aria-describedby={hintId}
          aria-required={field.required || undefined}
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          disabled={disabled}
          onChange={(event) => onChange(
            event.currentTarget.value === "" || !Number.isFinite(event.currentTarget.valueAsNumber)
              ? undefined
              : event.currentTarget.valueAsNumber,
          )}
          required={field.required}
          type="number"
          value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        />
        {hint ? <span className="mt-1 block text-xs text-zinc-400" id={hintId}>{hint}</span> : null}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="block">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <select
          aria-label={label}
          aria-describedby={hintId}
          aria-required={field.required || undefined}
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          required={field.required}
          value={canonicalStringValue}
        >
          <option value="" />
          {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {hint ? <span className="mt-1 block text-xs text-zinc-400" id={hintId}>{hint}</span> : null}
      </label>
    );
  }
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <input
        aria-label={label}
        aria-describedby={hintId}
        aria-required={field.required || undefined}
        className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        disabled={disabled}
        maxLength={getMetadataInputMaxLength(field)}
        onBlur={() => {
          if (!draft || !draftMatchesCanonical) {
            setInputState({ draft: null, identity: metadataDraftIdentity, observedCanonical: canonicalStringValue });
            return;
          }
          if (canonicalStringValue !== draft.expectedCanonical) {
            onChange(getEditableMetadataValue(field, draft.raw));
          }
          setInputState({ draft: null, identity: metadataDraftIdentity, observedCanonical: canonicalStringValue });
        }}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const nextValue = getEditableMetadataValue(field, raw);
          if (supportsRawDraft && event.currentTarget.ownerDocument.activeElement === event.currentTarget) {
            const expectedCanonical = getCanonicalEditableValue(field, nextValue);
            setInputState({
              draft: {
                baseCanonical: canonicalStringValue,
                expectedCanonical,
                hasObservedExpectedCanonical: expectedCanonical === canonicalStringValue,
                raw,
              },
              identity: metadataDraftIdentity,
              observedCanonical: canonicalStringValue,
            });
          }
          onChange(nextValue);
        }}
        onFocus={() => {
          if (!supportsRawDraft) return;
          setInputState({
            draft: {
              baseCanonical: canonicalStringValue,
              expectedCanonical: canonicalStringValue,
              hasObservedExpectedCanonical: true,
              raw: canonicalStringValue,
            },
            identity: metadataDraftIdentity,
            observedCanonical: canonicalStringValue,
          });
        }}
        required={field.required}
        type={field.type === "date" ? "date" : "text"}
        value={supportsRawDraft && draftMatchesCanonical ? draft!.raw : canonicalStringValue}
      />
      {hint ? <span className="mt-1 block text-xs text-zinc-400" id={hintId}>{hint}</span> : null}
    </label>
  );
}

type MetadataInputDraft = {
  baseCanonical: string;
  expectedCanonical: string;
  hasObservedExpectedCanonical: boolean;
  raw: string;
};

type MetadataInputState = {
  draft: MetadataInputDraft | null;
  identity: object;
  observedCanonical: string;
};

function reconcileMetadataDraft(
  draft: MetadataInputDraft | null,
  canonical: string,
): MetadataInputDraft | null {
  if (!draft) return null;
  if (canonical === draft.expectedCanonical) {
    return draft.hasObservedExpectedCanonical
      ? draft
      : { ...draft, hasObservedExpectedCanonical: true };
  }
  if (canonical === draft.baseCanonical && !draft.hasObservedExpectedCanonical) {
    return draft;
  }
  return null;
}

function canDisplayMetadataDraft(draft: MetadataInputDraft | null, canonical: string) {
  return draft !== null && (
    canonical === draft.expectedCanonical
    || (canonical === draft.baseCanonical && !draft.hasObservedExpectedCanonical)
  );
}

function getEditableMetadataValue(field: ProjectMetadataField, raw: string): DocumentMetadataValue {
  return field.type === "tags"
    ? raw.split(",").map((tag) => tag.trim()).filter(Boolean)
    : raw;
}

function getCanonicalEditableValue(field: ProjectMetadataField, value: DocumentMetadataValue) {
  if (field.type === "tags") return Array.isArray(value) ? value.join(", ") : "";
  return typeof value === "string" ? value.trim() : "";
}

function getMetadataInputMaxLength(field: ProjectMetadataField) {
  const limits = getProjectMetadataFieldLimits(field);
  if (field.type === "text") return limits.maxLength;
  if (field.type === "tags") {
    return limits.maxItems! * limits.itemMaxLength! + Math.max(0, limits.maxItems! - 1) * 2;
  }
  return undefined;
}

function getMetadataFieldHint(field: ProjectMetadataField, language: ProjectLocale) {
  const limits = getProjectMetadataFieldLimits(field);
  const parts: string[] = [];
  if (field.required) parts.push(language === "ko" ? "필수" : "Required");
  if (field.type === "text") {
    parts.push(language === "ko" ? `최대 ${String(limits.maxLength)}자` : `Up to ${String(limits.maxLength)} characters`);
  }
  if (field.type === "tags") {
    parts.push(language === "ko" ? `최대 ${String(limits.maxItems)}개` : `Up to ${String(limits.maxItems)} tags`);
    parts.push(language === "ko" ? `항목당 ${String(limits.itemMaxLength)}자` : `${String(limits.itemMaxLength)} characters each`);
  }
  return parts.join(" · ");
}

function getStringMetadata(value: DocumentMetadata[string]) {
  return typeof value === "string" ? value : "";
}
