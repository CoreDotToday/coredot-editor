"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";

type DocumentImportButtonProps = {
  onImported?: (documentId: string) => void;
};

export function DocumentImportButton({ onImported = redirectToDocument }: DocumentImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function importFile(file: File) {
    setIsImporting(true);
    setErrorMessage("");

    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/documents/import", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Failed to import DOCX");
      }

      const body = (await response.json()) as { document?: { id?: string } };
      if (!body.document?.id) {
        throw new Error("Imported document id missing");
      }

      onImported(body.document.id);
    } catch {
      setErrorMessage("DOCX를 가져오지 못했습니다.");
    } finally {
      setIsImporting(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        aria-label="DOCX 파일 선택"
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
        type="button"
      >
        <Upload aria-hidden="true" className="size-4" />
        {isImporting ? "가져오는 중..." : "DOCX 가져오기"}
      </button>
      {errorMessage ? (
        <p className="text-xs leading-5 text-red-600" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function redirectToDocument(documentId: string) {
  window.location.href = `/documents/${documentId}`;
}
