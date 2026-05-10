"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AiReviewPanel, type AiReviewProposal } from "@/components/ai/AiReviewPanel";
import { AiRunHistory, type AiRunHistoryItem } from "@/components/ai/AiRunHistory";
import { PromptTemplatePanel } from "@/components/templates/PromptTemplatePanel";
import type { AiProposalRecord, AiRunRecord, DocumentRecord, PromptTemplateRecord, TiptapJson } from "@/db/schema";
import { replaceTextInTiptapJson } from "@/features/documents/tiptap-replace";
import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import {
  EDITOR_LANGUAGE_STORAGE_KEY,
  editorLanguageOptions,
  editorMessages,
  formatEditorMessage,
  isEditorLanguage,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import { validateTemplateVariables } from "@/features/templates/template-validation";
import { DocumentEditor } from "./DocumentEditor";

type ShellDocument = Pick<DocumentRecord, "id" | "title" | "contentJson" | "plainText">;
type ShellTemplate = Pick<PromptTemplateRecord, "id" | "name" | "category" | "variableSchemaJson">;
type ShellTemplateField = ShellTemplate["variableSchemaJson"]["fields"][number];
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

type AiSnapshot = {
  aiRuns: ShellAiRun[];
  proposals: ShellProposal[];
};

type ReviewResponse = {
  run?: ShellAiRun;
  proposals?: ShellProposal[];
};

type RewriteResponse = {
  run?: ShellAiRun;
  proposal?: ShellProposal | null;
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
  const initialTemplateVariables = useMemo(
    () => mergeMissingTemplateVariableDefaults(templates[0] ?? null, {}),
    [templates],
  );
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
  const [language, setLanguage] = useState<EditorLanguage>(() => readStoredEditorLanguage());
  const [selectionCommand, setSelectionCommand] = useState<SelectionCommandPayload | null>(null);
  const [observedDocument, setObservedDocument] = useState<DocumentSnapshot>(incomingDocument);
  const [observedAiSnapshot, setObservedAiSnapshot] = useState<AiSnapshot>({ aiRuns, proposals });
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [reviewProposals, setReviewProposals] = useState<AiReviewProposal[]>(proposals);
  const [reviewRuns, setReviewRuns] = useState<AiRunHistoryItem[]>(aiRuns);
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>(initialTemplateVariables);
  const [templateVariableErrors, setTemplateVariableErrors] = useState<Record<string, string>>({});
  const [isRewritingSelection, setIsRewritingSelection] = useState(false);
  const activeTemplateId = templates.some((template) => template.id === selectedTemplateId)
    ? selectedTemplateId
    : templates[0]?.id ?? "";
  const selectedTemplate = templates.find((template) => template.id === activeTemplateId) ?? null;
  const messages = editorMessages[language];

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
      setTemplateVariables(initialTemplateVariables);
      setTemplateVariableErrors({});
      setIsRewritingSelection(false);
    }
  }

  if (observedAiSnapshot.aiRuns !== aiRuns || observedAiSnapshot.proposals !== proposals) {
    setObservedAiSnapshot({ aiRuns, proposals });
    setReviewRuns(aiRuns);
    setReviewProposals(proposals);
  }

  const handleDraftChange = useCallback((nextDraft: DraftState) => {
    draftVersionRef.current += 1;
    setDraft(nextDraft);
    setSaveState("dirty");
  }, []);

  const handleLanguageChange = useCallback((nextLanguage: string) => {
    if (!isEditorLanguage(nextLanguage)) {
      return;
    }

    setLanguage(nextLanguage);
    window.localStorage.setItem(EDITOR_LANGUAGE_STORAGE_KEY, nextLanguage);
  }, []);

  const handleSelectionCommand = useCallback(async (command: string, selectedText: string) => {
    setSelectionCommand({
      command,
      selectedText,
      contentJson: draft.contentJson,
    });

    if (!selectedTemplate) {
      setReviewError(messages.errors.selectTemplateForSelection);
      return;
    }

    const variablesWithDefaults = mergeMissingTemplateVariableDefaults(selectedTemplate, templateVariables);
    setTemplateVariables(variablesWithDefaults);

    const variableValidation = validateTemplateVariables(selectedTemplate.variableSchemaJson, variablesWithDefaults);
    if (!variableValidation.ok) {
      setTemplateVariableErrors(variableValidation.errors);
      setReviewError(messages.errors.fillSelectionVariables);
      return;
    }

    setIsRewritingSelection(true);
    setReviewError("");
    setTemplateVariableErrors({});

    try {
      const response = await fetch("/api/ai/rewrite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          templateId: selectedTemplate.id,
          command,
          variables: collectTemplateVariables(selectedTemplate, variablesWithDefaults),
          selectedText,
          documentText: extractPlainTextFromTiptap(draft.contentJson),
          beforeContext: "",
          afterContext: "",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to rewrite selection");
      }

      const body = (await response.json()) as RewriteResponse;
      if (body.proposal) {
        setReviewProposals((currentProposals) => [body.proposal!, ...currentProposals]);
      }
      if (body.run) {
        setReviewRuns((currentRuns) => [body.run!, ...currentRuns]);
      }
    } catch {
      setReviewError(messages.errors.selectionRewriteFailed);
    } finally {
      setIsRewritingSelection(false);
    }
  }, [document.id, draft.contentJson, messages.errors, selectedTemplate, templateVariables]);

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

  const selectTemplate = useCallback((templateId: string) => {
    const nextTemplate = templates.find((template) => template.id === templateId) ?? null;
    setSelectedTemplateId(templateId);
    setTemplateVariables((currentVariables) => mergeMissingTemplateVariableDefaults(nextTemplate, currentVariables));
    setTemplateVariableErrors({});
    setReviewError("");
  }, [templates]);

  const updateTemplateVariable = useCallback((name: string, value: string) => {
    setTemplateVariables((currentVariables) => ({ ...currentVariables, [name]: value }));
    setTemplateVariableErrors((currentErrors) => {
      const remainingErrors = { ...currentErrors };
      delete remainingErrors[name];
      return remainingErrors;
    });
    setReviewError("");
  }, []);

  const runDocumentReview = useCallback(async () => {
    if (!selectedTemplate) {
      return;
    }

    const variablesWithDefaults = mergeMissingTemplateVariableDefaults(selectedTemplate, templateVariables);
    setTemplateVariables(variablesWithDefaults);

    const variableValidation = validateTemplateVariables(selectedTemplate.variableSchemaJson, variablesWithDefaults);
    if (!variableValidation.ok) {
      setTemplateVariableErrors(variableValidation.errors);
      setReviewError(messages.errors.fillReviewVariables);
      return;
    }

    setIsReviewing(true);
    setReviewError("");
    setTemplateVariableErrors({});

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
          variables: collectTemplateVariables(selectedTemplate, variablesWithDefaults),
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
      setReviewError(messages.errors.reviewFailed);
    } finally {
      setIsReviewing(false);
    }
  }, [document.id, draft.contentJson, messages.errors, selectedTemplate, templateVariables]);

  const updateProposalStatus = useCallback(async (proposalId: string, status: AiReviewProposal["status"]) => {
    const previousProposal = reviewProposals.find((proposal) => proposal.id === proposalId);
    if (!previousProposal) {
      return;
    }

    const previousDraft = draft;
    const previousSaveState = saveState;
    let appliedDraftVersion: number | null = null;

    if (status === "accepted") {
      const appliedDraft = replaceTextInTiptapJson(
        draft.contentJson,
        previousProposal.targetText,
        previousProposal.replacementText,
      );

      if (!appliedDraft.ok) {
        setReviewError(messages.errors.updateProposalFailed);
        return;
      }

      appliedDraftVersion = draftVersionRef.current + 1;
      draftVersionRef.current = appliedDraftVersion;
      setDraft({
        title: draft.title,
        contentJson: appliedDraft.contentJson,
      });
      setSaveState("dirty");
    }

    setReviewError("");
    setReviewProposals((currentProposals) =>
      currentProposals.map((proposal) => (proposal.id === proposalId ? { ...proposal, status } : proposal)),
    );

    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        throw new Error("Failed to update proposal status");
      }

      const body = (await response.json()) as { proposal?: AiReviewProposal };
      if (body.proposal) {
        setReviewProposals((currentProposals) =>
          currentProposals.map((proposal) => (proposal.id === proposalId ? body.proposal! : proposal)),
        );
      }
    } catch {
      setReviewProposals((currentProposals) =>
        currentProposals.map((proposal) => (proposal.id === proposalId ? previousProposal : proposal)),
      );
      if (appliedDraftVersion !== null && draftVersionRef.current === appliedDraftVersion) {
        setDraft(previousDraft);
        setSaveState(previousSaveState);
      }
      setReviewError(messages.errors.updateProposalFailed);
    }
  }, [draft, messages.errors, reviewProposals, saveState]);

  const updateProposalStatusLocally = useCallback((proposalId: string, status: AiReviewProposal["status"]) => {
    void updateProposalStatus(proposalId, status);
  }, [updateProposalStatus]);

  const selectedTemplateName = selectedTemplate?.name ?? "";

  return (
    <main className="flex h-screen min-h-[720px] bg-zinc-50 text-zinc-950">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <section className="border-b border-zinc-200 px-4 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">{messages.outline.title}</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-500">{messages.outline.empty}</p>
        </section>

        <PromptTemplatePanel
          messages={messages.templates}
          onSelectTemplate={selectTemplate}
          onVariableChange={updateTemplateVariable}
          selectedTemplateId={activeTemplateId}
          templates={templates}
          variableErrors={templateVariableErrors}
          variableValues={templateVariables}
        />

        <AiRunHistory language={language} messages={messages.history} runs={reviewRuns} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6">
          <div aria-live="polite" className="text-xs font-medium uppercase tracking-normal text-zinc-500" role="status">
            {messages.saveState[saveState]}
          </div>
          <div className="flex items-center gap-3">
            <label className="sr-only" htmlFor="editor-language">
              {messages.header.language}
            </label>
            <select
              aria-label={messages.header.language}
              className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-500"
              id="editor-language"
              onChange={(event) => handleLanguageChange(event.currentTarget.value)}
              value={language}
            >
              {editorLanguageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={saveState === "saved" || saveState === "saving"}
              onClick={saveDraft}
              type="button"
            >
              {saveState === "saving" ? messages.header.saving : messages.header.save}
            </button>
          </div>
        </header>

        <DocumentEditor
          key={document.id}
          contentJson={draft.contentJson}
          language={language}
          messages={messages.editor}
          onChange={handleDraftChange}
          onSelectionCommand={handleSelectionCommand}
          title={draft.title}
        />
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-white">
        <AiReviewPanel
          errorMessage={reviewError}
          isReviewing={isReviewing}
          messages={messages.aiReview}
          onReviewDocument={runDocumentReview}
          onUpdateProposalStatus={updateProposalStatusLocally}
          proposals={reviewProposals}
          selectedTemplateName={selectedTemplateName}
        />
        <section className="px-5 py-5">
          <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">
            {messages.selectionCommand.title}
          </h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            {selectionCommand
              ? formatEditorMessage(
                  isRewritingSelection ? messages.selectionCommand.running : messages.selectionCommand.last,
                  { command: selectionCommand.command },
                )
              : messages.selectionCommand.empty}
          </p>
          {selectionCommand ? (
            <p className="mt-2 truncate text-xs leading-5 text-zinc-500">
              {formatEditorMessage(messages.selectionCommand.selected, { selectedText: selectionCommand.selectedText })}
            </p>
          ) : null}
        </section>
      </aside>
    </main>
  );
}

function collectTemplateVariables(template: ShellTemplate, values: Record<string, string>) {
  return template.variableSchemaJson.fields.reduce<Record<string, string>>((variables, field) => {
    variables[field.name] = values[field.name] ?? "";
    return variables;
  }, {});
}

function readStoredEditorLanguage(): EditorLanguage {
  if (typeof window === "undefined") {
    return "en";
  }

  const storedLanguage = window.localStorage.getItem(EDITOR_LANGUAGE_STORAGE_KEY);
  return isEditorLanguage(storedLanguage) ? storedLanguage : "en";
}

function mergeMissingTemplateVariableDefaults(template: ShellTemplate | null, values: Record<string, string>) {
  if (!template) {
    return values;
  }

  return template.variableSchemaJson.fields.reduce<Record<string, string>>(
    (variables, field) => {
      if (!(field.name in variables)) {
        variables[field.name] = getTemplateVariableDefaultValue(field);
      }

      return variables;
    },
    { ...values },
  );
}

function getTemplateVariableDefaultValue(field: ShellTemplateField) {
  if (field.type === "select") {
    return field.options?.find((option) => option.toLowerCase() === "executive") ?? field.options?.[0] ?? "";
  }

  const normalizedName = field.name.toLowerCase();
  const normalizedLabel = field.label.toLowerCase();

  if (normalizedName.includes("audience") || normalizedLabel.includes("audience")) {
    return "Executive stakeholders";
  }

  if (
    normalizedName.includes("objective") ||
    normalizedName.includes("goal") ||
    normalizedName.includes("purpose") ||
    normalizedLabel.includes("objective") ||
    normalizedLabel.includes("goal") ||
    normalizedLabel.includes("purpose")
  ) {
    return "Improve the selected text while preserving the document's intent.";
  }

  return field.type === "textarea" ? "Use the current document context and preserve the author's intent." : "General";
}
