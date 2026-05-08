"use client";

import { Save } from "lucide-react";
import { useMemo, useState } from "react";
import type { PromptTemplateRecord } from "@/db/schema";

type PromptTemplateManagerProps = {
  templates: PromptTemplateRecord[];
};

type SaveState = "saved" | "dirty" | "saving" | "failed";

type TemplateDraft = {
  name: string;
  description: string;
  systemPrompt: string;
  variableSchemaText: string;
  isActive: boolean;
};

const saveStateLabel: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Unsaved",
  saving: "Saving",
  failed: "Save failed",
};

function createDraft(template: PromptTemplateRecord): TemplateDraft {
  return {
    name: template.name,
    description: template.description,
    systemPrompt: template.systemPrompt,
    variableSchemaText: JSON.stringify(template.variableSchemaJson, null, 2),
    isActive: template.isActive,
  };
}

export function PromptTemplateManager({ templates }: PromptTemplateManagerProps) {
  const [managedTemplates, setManagedTemplates] = useState(templates);
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const selectedTemplate = useMemo(
    () => managedTemplates.find((template) => template.id === selectedId) ?? managedTemplates[0] ?? null,
    [managedTemplates, selectedId],
  );
  const [draft, setDraft] = useState<TemplateDraft | null>(() =>
    selectedTemplate ? createDraft(selectedTemplate) : null,
  );
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [statusMessage, setStatusMessage] = useState("Saved");

  if (managedTemplates.length === 0 || !selectedTemplate || !draft) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 text-zinc-950">
        <p className="text-sm text-zinc-500">No templates found. Run the seed command.</p>
      </main>
    );
  }

  const selectTemplate = (template: PromptTemplateRecord) => {
    setSelectedId(template.id);
    setDraft(createDraft(template));
    setSaveState("saved");
    setStatusMessage("Saved");
  };

  const updateDraft = (nextDraft: Partial<TemplateDraft>) => {
    setDraft((currentDraft) => (currentDraft ? { ...currentDraft, ...nextDraft } : currentDraft));
    setSaveState("dirty");
    setStatusMessage("Unsaved changes");
  };

  const saveTemplate = async () => {
    let variableSchemaJson: PromptTemplateRecord["variableSchemaJson"];

    try {
      variableSchemaJson = JSON.parse(draft.variableSchemaText);
    } catch {
      setSaveState("failed");
      setStatusMessage("Variable schema must be valid JSON.");
      return;
    }

    setSaveState("saving");
    setStatusMessage("Saving");

    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(selectedTemplate.id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          category: selectedTemplate.category,
          systemPrompt: draft.systemPrompt,
          variableSchemaJson,
          isActive: draft.isActive,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save template");
      }

      const body = (await response.json()) as { template: PromptTemplateRecord };
      setManagedTemplates((currentTemplates) =>
        currentTemplates.map((template) => (template.id === body.template.id ? body.template : template)),
      );
      setDraft(createDraft(body.template));
      setSaveState("saved");
      setStatusMessage("Saved");
    } catch {
      setSaveState("failed");
      setStatusMessage("Save failed");
    }
  };

  return (
    <main className="flex min-h-screen bg-zinc-50 text-zinc-950">
      <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-200 bg-white">
        <header className="border-b border-zinc-200 px-5 py-5">
          <h1 className="text-base font-semibold">Prompt templates</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">Manage saved prompts used by document AI actions.</p>
        </header>

        <nav aria-label="Prompt templates" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ul className="space-y-1">
            {managedTemplates.map((template) => {
              const isSelected = template.id === selectedTemplate.id;

              return (
                <li key={template.id}>
                  <button
                    aria-current={isSelected ? "page" : undefined}
                    className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                      isSelected ? "bg-zinc-950 text-white" : "text-zinc-700 hover:bg-zinc-100"
                    }`}
                    onClick={() => selectTemplate(template)}
                    type="button"
                  >
                    <span className="block truncate text-sm font-medium">{template.name}</span>
                    <span className={`mt-1 block truncate text-xs ${isSelected ? "text-zinc-300" : "text-zinc-500"}`}>
                      {template.category}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6">
          <div aria-live="polite" className="text-xs font-medium uppercase tracking-normal text-zinc-500" role="status">
            {statusMessage}
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
            disabled={saveState === "saving" || saveState === "saved"}
            onClick={saveTemplate}
            type="button"
          >
            <Save aria-hidden="true" className="size-4" />
            {saveState === "saving" ? "Saving..." : "Save"}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <form className="mx-auto grid max-w-5xl gap-5" onSubmit={(event) => event.preventDefault()}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-name">
                Name
              </label>
              <input
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition-colors focus:border-zinc-950"
                id="template-name"
                onChange={(event) => updateDraft({ name: event.target.value })}
                value={draft.name}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-description">
                Description
              </label>
              <input
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition-colors focus:border-zinc-950"
                id="template-description"
                onChange={(event) => updateDraft({ description: event.target.value })}
                value={draft.description}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-system-prompt">
                System prompt
              </label>
              <textarea
                className="min-h-56 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none transition-colors focus:border-zinc-950"
                id="template-system-prompt"
                onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                value={draft.systemPrompt}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-variable-schema">
                Variable schema JSON
              </label>
              <textarea
                className="min-h-72 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none transition-colors focus:border-zinc-950"
                id="template-variable-schema"
                onChange={(event) => updateDraft({ variableSchemaText: event.target.value })}
                spellCheck={false}
                value={draft.variableSchemaText}
              />
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-zinc-700">
              <input
                checked={draft.isActive}
                className="size-4 accent-zinc-950"
                onChange={(event) => updateDraft({ isActive: event.target.checked })}
                type="checkbox"
              />
              Active
            </label>

            <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">{saveStateLabel[saveState]}</p>
          </form>
        </div>
      </section>
    </main>
  );
}
