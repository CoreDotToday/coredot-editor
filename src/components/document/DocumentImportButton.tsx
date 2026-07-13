"use client";

import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TiptapJson } from "@/db/schema";
import type { FidelityReport } from "@/features/documents/document-interchange";
import { fetchDocumentInterchange } from "@/features/documents/document-interchange-fetch";
import {
  editorMessages,
  getFidelityFeatureLabel,
  getFidelityOutcomeLabel,
  readStoredEditorLanguage,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import { DocumentInterchangeDialog } from "./DocumentInterchangeDialog";

type DocumentImportButtonProps = {
  language?: EditorLanguage;
  onImported?: (documentId: string) => void;
};

type PendingImport = {
  contentJson: TiptapJson;
  creationKey: string;
  fidelity: FidelityReport;
  title: string;
  warnings: string[];
};

export function DocumentImportButton({ language, onImported = redirectToDocument }: DocumentImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const resolvedLanguage = language ?? readStoredEditorLanguage();
  const messages = editorMessages[resolvedLanguage].documentInterchange;

  useEffect(() => () => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
  }, []);

  async function importFile(file: File) {
    activeRequestRef.current?.abort();
    const requestController = new AbortController();
    activeRequestRef.current = requestController;
    setIsImporting(true);
    setErrorMessage("");
    setConfirmError("");

    try {
      const formData = new FormData();
      formData.set("file", file);
      const body = await fetchDocumentInterchange("/api/documents/import", {
        method: "POST",
        body: formData,
        signal: requestController.signal,
      }, async (response) => {
        if (!response.ok) throw new Error("Failed to import DOCX");
        return response.json() as Promise<{
        fidelity?: FidelityReport;
        preview?: { contentJson?: TiptapJson; title?: string };
        warnings?: string[];
        }>;
      });
      if (
        !body.preview?.contentJson ||
        body.preview.contentJson.type !== "doc" ||
        typeof body.preview.title !== "string" ||
        !body.fidelity ||
        !Array.isArray(body.fidelity.items)
      ) {
        throw new Error("Import preview missing");
      }

      setPendingImport({
        contentJson: body.preview.contentJson,
        creationKey: createImportCreationKey(),
        fidelity: body.fidelity,
        title: body.preview.title,
        warnings: body.warnings ?? [],
      });
    } catch {
      if (activeRequestRef.current === requestController && !requestController.signal.aborted) {
        setErrorMessage(messages.importFailed);
      }
    } finally {
      if (activeRequestRef.current === requestController) {
        activeRequestRef.current = null;
        setIsImporting(false);
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      }
    }
  }

  async function confirmImport(pending: PendingImport) {
    activeRequestRef.current?.abort();
    const requestController = new AbortController();
    activeRequestRef.current = requestController;
    setIsImporting(true);
    setConfirmError("");
    try {
      const body = await fetchDocumentInterchange("/api/documents/import", {
        body: JSON.stringify({ action: "confirm", contentJson: pending.contentJson, title: pending.title }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": pending.creationKey,
        },
        method: "POST",
        signal: requestController.signal,
      }, async (response) => {
        if (!response.ok) throw new Error("Failed to confirm DOCX import");
        return response.json() as Promise<{ document?: { id?: string } }>;
      });
      if (!body.document?.id) throw new Error("Imported document id missing");
      setPendingImport(null);
      onImported(body.document.id);
    } catch {
      if (activeRequestRef.current === requestController && !requestController.signal.aborted) {
        setConfirmError(messages.importFailed);
      }
    } finally {
      if (activeRequestRef.current === requestController) {
        activeRequestRef.current = null;
        setIsImporting(false);
      }
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        aria-label={messages.importInputLabel}
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            void importFile(file);
          }
        }}
        type="file"
      />
      <button
        className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        disabled={isImporting}
        onClick={() => inputRef.current?.click()}
        ref={triggerRef}
        type="button"
      >
        <Upload aria-hidden="true" className="size-4" />
        {isImporting ? messages.importing : messages.importButton}
      </button>
      {errorMessage ? (
        <p className="text-xs leading-5 text-red-600" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {pendingImport ? (
        <DocumentInterchangeDialog
          actionsDisabled={isImporting}
          cancelLabel={messages.cancel}
          confirmLabel={confirmError ? messages.retryImport : messages.openImportedDocument}
          description={messages.importReviewDescription}
          onClose={() => {
            setConfirmError("");
            setPendingImport(null);
          }}
          onConfirm={() => void confirmImport(pendingImport)}
          returnFocusRef={triggerRef}
          title={messages.importReviewTitle}
        >
          {confirmError ? (
            <p className="mt-4 text-sm leading-5 text-red-600" role="alert">
              {confirmError}
            </p>
          ) : null}
          <h3 className="mt-4 text-sm font-semibold text-zinc-900">{messages.fidelityTitle}</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-700">
            {pendingImport.fidelity.items
              .filter((item) => item.feature !== "conversion-warning")
              .map((item) => (
                <li key={`${item.feature}:${item.outcome}:${item.message ?? ""}`}>
                  {getFidelityFeatureLabel(item.feature, resolvedLanguage)}: {getFidelityOutcomeLabel(
                    item.outcome,
                    resolvedLanguage,
                  )}
                </li>
              ))}
          </ul>
          {pendingImport.warnings.length > 0 ? (
            <>
              <h3 className="mt-4 text-sm font-semibold text-amber-900">{messages.warningsTitle}</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {pendingImport.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </>
          ) : null}
        </DocumentInterchangeDialog>
      ) : null}
    </div>
  );
}

function redirectToDocument(documentId: string) {
  window.location.href = `/documents/${documentId}`;
}

function createImportCreationKey() {
  return `import_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
