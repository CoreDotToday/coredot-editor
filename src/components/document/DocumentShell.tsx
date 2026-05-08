"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AiReviewPanel, type AiReviewProposal } from "@/components/ai/AiReviewPanel";
import { AiRunHistory, type AiRunHistoryItem } from "@/components/ai/AiRunHistory";
import { PromptTemplatePanel } from "@/components/templates/PromptTemplatePanel";
import type { AiProposalRecord, AiRunRecord, DocumentRecord, PromptTemplateRecord, TiptapJson } from "@/db/schema";
import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import { DocumentEditor } from "./DocumentEditor";

type ShellDocument = Pick<DocumentRecord, "id" | "title" | "contentJson" | "plainText">;
type ShellTemplate = Pick<PromptTemplateRecord, "id" | "name" | "category">;
type ShellAiRun = Pick<AiRunRecord, "id" | "commandType" | "status" | "createdAt">;
type ShellProposal = Pick<
  AiProposalRecord,
  "id" | "targetText" | "replacementText" | "explanation" | "status"
>;
type SaveState = "saved" | "dirty" | "saving" | "failed";

type DocumentShellProps = {
  document: ShellDocument;
  templates: ShellTemplate[];
  aiRuns: ShellAiRun[];
  proposals?: ShellProposal[];
};

type DraftState = {
  title: string;
  contentJson: TiptapJson;
};

type SelectionCommandPayload = {
  command: string;
  selectedText: string;
  contentJson: TiptapJson;
};

type DocumentSnapshot = {
  id: string;
  title: string;
  contentJson: TiptapJson;
};

const saveStateLabel: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Unsaved",
  saving: "Saving",
  failed: "Save failed",
};

type ReviewResponse = {
  run?: ShellAiRun;
  proposals?: ShellProposal[];
};

export function DocumentShell({ aiRuns, document, proposals = [], templates }: DocumentShellProps) {
  return (
    <DocumentShellContent
      key={document.id}
      aiRuns={aiRuns}
      document={document}
      proposals={proposals}
      templates={templates}
    />
  );
}

function DocumentShellContent({ aiRuns, document, proposals = [], templates }: DocumentShellProps) {
  const incomingDocument = useMemo(
    () => ({
      id: document.id,
      title: document.title,
      contentJson: document.contentJson,
    }),
    [document.contentJson, document.id, document.title],
  );
  const initialDraft = useMemo(
    () => ({
      title: incomingDocument.title,
      contentJson: incomingDocument.contentJson,
    }),
    [incomingDocument],
  );
  const [draft, setDraft] = useState<DraftState>(initialDraft);
  const draftVersionRef = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [selectionCommand, setSelectionCommand] = useState<SelectionCommandPayload | null>(null);
  const [observedDocument, setObservedDocument] = useState<DocumentSnapshot>(incomingDocument);
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [reviewProposals, setReviewProposals] = useState<AiReviewProposal[]>(proposals);
  const [reviewRuns, setReviewRuns] = useState<AiRunHistoryItem[]>(aiRuns);
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;

  if (
    observedDocument.id !== incomingDocument.id ||
    observedDocument.title !== incomingDocument.title ||
    observedDocument.contentJson !== incomingDocument.contentJson
  ) {
    setObservedDocument(incomingDocument);

    if (saveState === "saved") {
      setDraft(initialDraft);
      setSelectionCommand(null);
      setSelectedTemplateId(templates[0]?.id ?? "");
      setReviewProposals(proposals);
      setReviewRuns(aiRuns);
      setIsReviewing(false);
      setReviewError("");
    }
  }

  const handleDraftChange = useCallback((nextDraft: DraftState) => {
    draftVersionRef.current += 1;
    setDraft(nextDraft);
    setSaveState("dirty");
  }, []);

  const handleSelectionCommand = useCallback((command: string, selectedText: string) => {
    setSelectionCommand({
      command,
      selectedText,
      contentJson: draft.contentJson,
    });
  }, [draft.contentJson]);

  const saveDraft = useCallback(async () => {
    const savingVersion = draftVersionRef.current;
    const savingDraft = draft;

    setSaveState("saving");

    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(savingDraft),
      });

      if (!response.ok) {
        throw new Error("Failed to save document");
      }

      setSaveState((currentState) => (draftVersionRef.current === savingVersion ? "saved" : currentState));
    } catch {
      setSaveState((currentState) => (draftVersionRef.current === savingVersion ? "failed" : currentState));
    }
  }, [document.id, draft]);

  const runDocumentReview = useCallback(async () => {
    if (!selectedTemplate) {
      return;
    }

    setIsReviewing(true);
    setReviewError("");

    try {
      const response = await fetch("/api/ai/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          templateId: selectedTemplate.id,
          command: "Review document",
          variables: {},
          documentText: extractPlainTextFromTiptap(draft.contentJson),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to run review");
      }

      const body = (await response.json()) as ReviewResponse;
      setReviewProposals(body.proposals ?? []);
      if (body.run) {
        setReviewRuns((currentRuns) => [body.run!, ...currentRuns]);
      }
    } catch {
      setReviewError("Review failed. Try again.");
    } finally {
      setIsReviewing(false);
    }
  }, [document.id, draft.contentJson, selectedTemplate]);

  const updateProposalStatus = useCallback((proposalId: string, status: AiReviewProposal["status"]) => {
    setReviewProposals((currentProposals) =>
      currentProposals.map((proposal) => (proposal.id === proposalId ? { ...proposal, status } : proposal)),
    );
  }, []);

  return (
    <main className="flex h-screen min-h-[720px] bg-zinc-50 text-zinc-950">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <section className="border-b border-zinc-200 px-4 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">Outline</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-500">Headings will appear here as the document develops.</p>
        </section>

        <PromptTemplatePanel
          selectedTemplateId={selectedTemplateId}
          templates={templates}
          onSelectTemplate={setSelectedTemplateId}
        />

        <AiRunHistory runs={reviewRuns} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6">
          <div aria-live="polite" className="text-xs font-medium uppercase tracking-normal text-zinc-500" role="status">
            {saveStateLabel[saveState]}
          </div>
          <button
            className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
            disabled={saveState === "saved" || saveState === "saving"}
            onClick={saveDraft}
            type="button"
          >
            {saveState === "saving" ? "Saving..." : "Save"}
          </button>
        </header>

        <DocumentEditor
          key={document.id}
          contentJson={draft.contentJson}
          onChange={handleDraftChange}
          onSelectionCommand={handleSelectionCommand}
          title={draft.title}
        />
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-white">
        <AiReviewPanel
          errorMessage={reviewError}
          isReviewing={isReviewing}
          onReviewDocument={runDocumentReview}
          onUpdateProposalStatus={updateProposalStatus}
          proposals={reviewProposals}
          selectedTemplateName={selectedTemplate?.name ?? ""}
        />
        <section className="px-5 py-5">
          <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">Selection command</h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            {selectionCommand
              ? `Last selection command: ${selectionCommand.command}`
              : "Select text in the editor to reveal AI commands."}
          </p>
          {selectionCommand ? (
            <p className="mt-2 truncate text-xs leading-5 text-zinc-500">Selected: {selectionCommand.selectedText}</p>
          ) : null}
        </section>
      </aside>
    </main>
  );
}
