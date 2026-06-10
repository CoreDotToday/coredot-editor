import { Clipboard, Database } from "lucide-react";
import { useState } from "react";
import {
  formatAiContextSnapshotForCopy,
  type AiContextSnapshot,
} from "@/features/ai/ai-context-snapshot";
import { formatEditorMessage } from "@/features/i18n/editor-language";

export type AiContextInspectorMessages = {
  charCount: string;
  command: string;
  copied: string;
  copy: string;
  document: string;
  empty: string;
  model: string;
  references: string;
  selection: string;
  template: string;
  title: string;
  variables: string;
};

type AiContextInspectorProps = {
  messages: AiContextInspectorMessages;
  snapshot: AiContextSnapshot | null;
};

export function AiContextInspector({ messages, snapshot }: AiContextInspectorProps) {
  const [copyStatus, setCopyStatus] = useState("");

  if (!snapshot) {
    return (
      <section aria-label={messages.title} className="border-t border-zinc-200 px-5 py-4">
        <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">{messages.title}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-500">{messages.empty}</p>
      </section>
    );
  }

  const modelLabel = [snapshot.ai?.provider, snapshot.ai?.model].filter(Boolean).join(" / ") || "-";
  const referencedDocuments = snapshot.references?.documents ?? [];

  const copySnapshot = async () => {
    try {
      await navigator.clipboard?.writeText(formatAiContextSnapshotForCopy(snapshot));
      setCopyStatus(messages.copied);
    } catch {
      setCopyStatus("");
    }
  };

  return (
    <section aria-label={messages.title} className="border-t border-zinc-200 px-5 py-4" role="region">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Database aria-hidden="true" className="size-3.5 shrink-0 text-zinc-500" />
          <h3 className="truncate text-xs font-medium uppercase tracking-normal text-zinc-500">{messages.title}</h3>
        </div>
        <button
          aria-label={messages.copy}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-zinc-200 px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
          onClick={() => void copySnapshot()}
          type="button"
        >
          <Clipboard aria-hidden="true" className="size-3.5" />
          {messages.copy}
        </button>
      </div>
      {copyStatus ? (
        <p aria-live="polite" className="mt-2 text-xs font-medium text-emerald-700">
          {copyStatus}
        </p>
      ) : null}
      <dl className="mt-3 space-y-2 text-sm">
        <SummaryRow label={messages.command} value={snapshot.command} />
        <SummaryRow label={messages.model} value={modelLabel} />
        <SummaryRow label={messages.template} value={snapshot.template.name} />
        <SummaryRow
          label={messages.document}
          value={`${snapshot.document.title} · ${formatEditorMessage(messages.charCount, {
            count: String(snapshot.document.charCount),
          })}`}
        />
        {snapshot.selection ? (
          <SummaryRow
            label={messages.selection}
            value={formatEditorMessage(messages.charCount, { count: String(snapshot.selection.charCount) })}
          />
        ) : null}
        {referencedDocuments.length > 0 ? (
          <SummaryRow
            label={messages.references}
            value={referencedDocuments
              .map(
                (document) =>
                  `${document.title} · ${formatEditorMessage(messages.charCount, {
                    count: String(document.charCount),
                  })}`,
              )
              .join(", ")}
          />
        ) : null}
        <SummaryRow label={messages.variables} value={snapshot.variables.names.join(", ") || "-"} />
      </dl>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-zinc-800">{value}</dd>
    </div>
  );
}
