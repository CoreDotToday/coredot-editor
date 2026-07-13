"use client";

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
  messages?: DocumentMetadataPanelMessages;
  onChange: (change: { metadataJson?: DocumentMetadata; readiness?: DocumentReadiness }) => void;
  profile?: ProjectProfile;
  readiness: DocumentReadiness;
};

export type DocumentMetadataPanelMessages = {
  category: string;
  dueDate: string;
  owner: string;
  readiness: string;
  readinessLabels: Record<DocumentReadiness, string>;
  tags: string;
  title: string;
};

const defaultMessages: DocumentMetadataPanelMessages = {
  category: "분류",
  dueDate: "기한",
  owner: "소유자",
  readiness: "준비 상태",
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
  messages = defaultMessages,
  onChange,
  profile = getProjectProfile("default"),
  readiness,
}: DocumentMetadataPanelProps) {
  const readinessOptions = getProjectReadinessOptions(profile, readiness);

  const updateMetadata = (key: string, value: DocumentMetadataValue | undefined) => {
    const nextMetadata = { ...metadata };
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete nextMetadata[key];
    } else {
      nextMetadata[key] = value;
    }
    onChange({ metadataJson: nextMetadata });
  };

  return (
    <section className="shrink-0 border-t border-zinc-200 px-4 py-4">
      <h2 className="text-sm font-semibold text-zinc-950">{messages.title}</h2>
      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-zinc-500">{messages.readiness}</span>
          <select
            aria-label={messages.readiness}
            className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
            onChange={(event) => onChange({ readiness: event.currentTarget.value as DocumentReadiness })}
            value={readiness}
          >
            {readinessOptions.map((state) => (
              <option key={state.id} value={state.id}>
                {state.labels[language] ?? messages.readinessLabels[state.id]}
              </option>
            ))}
          </select>
        </label>
        {profile.metadataFields.map((field) => (
          <MetadataFieldInput
            field={field}
            key={field.id}
            label={field.labels[language]}
            language={language}
            onChange={(value) => updateMetadata(field.id, value)}
            value={metadata[field.id]}
          />
        ))}
      </div>
    </section>
  );
}

function MetadataFieldInput({
  field,
  label,
  language,
  onChange,
  value,
}: {
  field: ProjectMetadataField;
  label: string;
  language: ProjectLocale;
  onChange: (value: DocumentMetadataValue | undefined) => void;
  value: DocumentMetadata[string];
}) {
  const hint = getMetadataFieldHint(field, language);
  const hintId = hint ? `metadata-field-${field.id}-hint` : undefined;
  if (field.type === "boolean") {
    return (
      <label className="block">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <select
          aria-label={label}
          aria-describedby={hintId}
          aria-required={field.required || undefined}
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
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
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
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
  const stringValue = field.type === "tags"
    ? Array.isArray(value) ? value.join(", ") : getStringMetadata(value)
    : getStringMetadata(value);
  if (field.type === "select") {
    return (
      <label className="block">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <select
          aria-label={label}
          aria-describedby={hintId}
          aria-required={field.required || undefined}
          className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
          onChange={(event) => onChange(event.currentTarget.value)}
          required={field.required}
          value={stringValue}
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
        className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
        maxLength={getMetadataInputMaxLength(field)}
        onChange={(event) => onChange(
          field.type === "tags"
            ? event.currentTarget.value.split(",").map((tag) => tag.trim()).filter(Boolean)
            : event.currentTarget.value,
        )}
        required={field.required}
        type={field.type === "date" ? "date" : "text"}
        value={stringValue}
      />
      {hint ? <span className="mt-1 block text-xs text-zinc-400" id={hintId}>{hint}</span> : null}
    </label>
  );
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
