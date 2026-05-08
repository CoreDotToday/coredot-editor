"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { AiRunRecord, DocumentRecord, PromptTemplateRecord, TiptapJson } from "@/db/schema";
import { DocumentEditor } from "./DocumentEditor";

type ShellDocument = Pick<DocumentRecord, "id" | "title" | "contentJson" | "plainText">;
type ShellTemplate = Pick<PromptTemplateRecord, "id" | "name" | "category">;
type ShellAiRun = Pick<AiRunRecord, "id" | "commandType" | "status" | "createdAt">;
type SaveState = "saved" | "dirty" | "saving" | "failed";

type DocumentShellProps = {
  document: ShellDocument;
  templates: ShellTemplate[];
  aiRuns: ShellAiRun[];
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

const saveStateLabel: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Unsaved",
  saving: "Saving",
  failed: "Save failed",
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function DocumentShell({ aiRuns, document, templates }: DocumentShellProps) {
  return <DocumentShellContent key={document.id} aiRuns={aiRuns} document={document} templates={templates} />;
}

function DocumentShellContent({ aiRuns, document, templates }: DocumentShellProps) {
  const initialDraft = useMemo(
    () => ({
      title: document.title,
      contentJson: document.contentJson,
    }),
    [document.contentJson, document.title],
  );
  const [draft, setDraft] = useState<DraftState>(initialDraft);
  const draftRef = useRef<DraftState>(initialDraft);
  const draftVersionRef = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [selectionCommand, setSelectionCommand] = useState<SelectionCommandPayload | null>(null);

  const templateGroups = useMemo(() => {
    return templates.reduce<Record<string, ShellTemplate[]>>((groups, template) => {
      const group = groups[template.category] ?? [];
      group.push(template);
      groups[template.category] = group;
      return groups;
    }, {});
  }, [templates]);

  const handleDraftChange = useCallback((nextDraft: DraftState) => {
    draftRef.current = nextDraft;
    draftVersionRef.current += 1;
    setDraft(nextDraft);
    setSaveState("dirty");
  }, []);

  const handleSelectionCommand = useCallback((command: string, selectedText: string) => {
    setSelectionCommand({
      command,
      selectedText,
      contentJson: draftRef.current.contentJson,
    });
  }, []);

  const saveDraft = useCallback(async () => {
    const savingVersion = draftVersionRef.current;
    const savingDraft = draftRef.current;

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
  }, [document.id]);

  return (
    <main className="flex h-screen min-h-[720px] bg-zinc-50 text-zinc-950">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <section className="border-b border-zinc-200 px-4 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">Outline</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-500">Headings will appear here as the document develops.</p>
        </section>

        <section className="min-h-0 flex-1 overflow-y-auto border-b border-zinc-200 px-4 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">Templates</h2>
          {templates.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-zinc-500">No active templates.</p>
          ) : (
            <div className="mt-3 space-y-5">
              {Object.entries(templateGroups).map(([category, categoryTemplates]) => (
                <div key={category}>
                  <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">{category}</h3>
                  <ul className="mt-2 space-y-1">
                    {categoryTemplates.map((template) => (
                      <li key={template.id}>
                        <button
                          className="w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                          type="button"
                        >
                          {template.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="px-4 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">History</h2>
          {aiRuns.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-zinc-500">No AI runs yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {aiRuns.slice(0, 5).map((run) => (
                <li key={run.id} className="text-sm text-zinc-700">
                  <div className="font-medium">{run.commandType.replace("_", " ")}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {run.status} · {dateFormatter.format(run.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
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
        <section className="border-b border-zinc-200 px-5 py-5">
          <h2 className="text-sm font-semibold text-zinc-950">AI Review</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-500">
            Run document reviews and selection rewrites from this panel.
          </p>
        </section>
        <section className="px-5 py-5">
          <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">Selection command</h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            {selectionCommand
              ? `Last selection command: ${selectionCommand.command}`
              : "Select text in the editor to reveal AI commands."}
          </p>
        </section>
      </aside>
    </main>
  );
}
