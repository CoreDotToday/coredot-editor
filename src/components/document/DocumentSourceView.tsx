"use client";

import { CheckCircle2, Clipboard, Download } from "lucide-react";
import { useMemo, useState } from "react";
import type { TiptapJson } from "@/db/schema";
import { buildDocumentSourceSnapshot } from "@/features/documents/document-source-view-model";
import type { EditorMessages } from "@/features/i18n/editor-language";

type DocumentSourceViewProps = {
  contentJson: TiptapJson;
  messages: EditorMessages["sourceView"];
  title: string;
};

export function DocumentSourceView({ contentJson, messages, title }: DocumentSourceViewProps) {
  const [copiedLabel, setCopiedLabel] = useState("");
  const snapshot = useMemo(() => buildDocumentSourceSnapshot({ contentJson, title }), [contentJson, title]);
  const plainText = snapshot.plainText || messages.empty;

  const copyText = async (value: string) => {
    if (!navigator.clipboard?.writeText) return;

    await navigator.clipboard.writeText(value);
    setCopiedLabel(messages.copied);
  };

  const downloadJson = () => {
    const blob = new Blob([snapshot.jsonText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = snapshot.downloadFileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      aria-label={messages.regionLabel}
      className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 px-4 py-6"
      role="region"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p
              aria-label={snapshot.isJsonValid ? messages.jsonValid : messages.jsonInvalid}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
              role="status"
            >
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {snapshot.isJsonValid ? messages.jsonValid : messages.jsonInvalid}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              onClick={() => void copyText(snapshot.plainText)}
              type="button"
            >
              <Clipboard aria-hidden="true" className="size-3.5" />
              {messages.copyPlainText}
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              onClick={() => void copyText(snapshot.jsonText)}
              type="button"
            >
              <Clipboard aria-hidden="true" className="size-3.5" />
              {messages.copyJson}
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              onClick={downloadJson}
              type="button"
            >
              <Download aria-hidden="true" className="size-3.5" />
              {messages.downloadJson}
            </button>
          </div>
          {copiedLabel ? (
            <p aria-live="polite" className="text-xs font-medium text-emerald-700">
              {copiedLabel}
            </p>
          ) : null}
        </div>

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-950">{messages.plainTextTitle}</h2>
          <pre className="mt-3 whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-mono text-sm leading-6 text-zinc-700">
            {plainText}
          </pre>
        </section>
        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-950">{messages.jsonTitle}</h2>
          <pre className="mt-3 overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-50">
            {snapshot.jsonText}
          </pre>
        </section>
      </div>
    </section>
  );
}
