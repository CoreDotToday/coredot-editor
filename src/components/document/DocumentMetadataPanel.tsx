"use client";

import type { DocumentMetadata, DocumentReadiness } from "@/db/schema";

type DocumentMetadataPanelProps = {
  metadata: DocumentMetadata;
  messages?: DocumentMetadataPanelMessages;
  onChange: (change: { metadataJson?: DocumentMetadata; readiness?: DocumentReadiness }) => void;
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

const readinessValues: DocumentReadiness[] = ["draft", "needs_review", "ready", "approved"];

export function DocumentMetadataPanel({ metadata, messages = defaultMessages, onChange, readiness }: DocumentMetadataPanelProps) {
  const owner = getStringMetadata(metadata.owner);
  const dueDate = getStringMetadata(metadata.dueDate);
  const category = getStringMetadata(metadata.category);
  const tags = Array.isArray(metadata.tags) ? metadata.tags.join(", ") : getStringMetadata(metadata.tags);

  const updateMetadata = (key: string, value: string | string[]) => {
    const nextMetadata = { ...metadata };
    if (Array.isArray(value) ? value.length === 0 : !value.trim()) {
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
            {readinessValues.map((value) => (
              <option key={value} value={value}>
                {messages.readinessLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <MetadataInput label={messages.owner} onChange={(value) => updateMetadata("owner", value)} value={owner} />
        <MetadataInput label={messages.dueDate} onChange={(value) => updateMetadata("dueDate", value)} type="date" value={dueDate} />
        <MetadataInput label={messages.category} onChange={(value) => updateMetadata("category", value)} value={category} />
        <MetadataInput
          label={messages.tags}
          onChange={(value) =>
            updateMetadata(
              "tags",
              value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            )
          }
          value={tags}
        />
      </div>
    </section>
  );
}

function MetadataInput({
  label,
  onChange,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  type?: "date" | "text";
  value: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <input
        aria-label={label}
        className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
        onChange={(event) => onChange(event.currentTarget.value)}
        type={type}
        value={value}
      />
    </label>
  );
}

function getStringMetadata(value: DocumentMetadata[string]) {
  return typeof value === "string" ? value : "";
}
