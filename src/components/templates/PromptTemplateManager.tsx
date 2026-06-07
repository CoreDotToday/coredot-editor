"use client";

import { Archive, Plus, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptTemplateRecord } from "@/db/schema";
import {
  promptTemplatePayloadSchema,
  promptTemplateUpdatePayloadSchema,
} from "@/features/templates/template-validation";

type PromptTemplateManagerProps = {
  templates: PromptTemplateRecord[];
};

type SaveState = "saved" | "dirty" | "saving" | "failed";

type TemplateDraft = {
  name: string;
  description: string;
  category: string;
  systemPrompt: string;
  variableSchemaText: string;
  isActive: boolean;
};

type FormErrors = Partial<Record<"name" | "description" | "category" | "systemPrompt" | "variableSchemaText", string>>;

const NEW_TEMPLATE_ID = "__new_prompt_template__";

const saveStateLabel: Record<SaveState, string> = {
  saved: "저장됨",
  dirty: "저장되지 않음",
  saving: "저장 중",
  failed: "저장 실패",
};

function createDraft(template: PromptTemplateRecord): TemplateDraft {
  return {
    name: template.name,
    description: template.description,
    category: template.category,
    systemPrompt: template.systemPrompt,
    variableSchemaText: JSON.stringify(template.variableSchemaJson, null, 2),
    isActive: template.isActive,
  };
}

function createNewDraft(): TemplateDraft {
  return {
    name: "제목 없는 템플릿",
    description: "사용자 프롬프트 템플릿",
    category: "custom",
    systemPrompt: "당신은 문서 편집 어시스턴트입니다.",
    variableSchemaText: JSON.stringify({ fields: [], required: [] }, null, 2),
    isActive: true,
  };
}

function listVisibleTemplates(templates: PromptTemplateRecord[]) {
  return templates
    .filter((template) => template.isActive)
    .sort((first, second) => first.name.localeCompare(second.name));
}

function validationErrorsFromIssues(
  issues: Array<{ message: string; path: Array<PropertyKey> }>,
): FormErrors {
  const errors: FormErrors = {};

  for (const issue of issues) {
    const [field] = issue.path;

    if (field === "name" && !errors.name) {
      errors.name = issue.message;
    } else if (field === "description" && !errors.description) {
      errors.description = issue.message;
    } else if (field === "category" && !errors.category) {
      errors.category = issue.message;
    } else if (field === "systemPrompt" && !errors.systemPrompt) {
      errors.systemPrompt = issue.message;
    } else if (field === "variableSchemaJson" && !errors.variableSchemaText) {
      errors.variableSchemaText = issue.message;
    }
  }

  return errors;
}

export function PromptTemplateManager({ templates }: PromptTemplateManagerProps) {
  const [managedTemplates, setManagedTemplates] = useState(() => listVisibleTemplates(templates));
  const [selectedId, setSelectedId] = useState(managedTemplates[0]?.id ?? "");
  const selectedIdRef = useRef(selectedId);
  const selectionVersionRef = useRef(0);
  const draftVersionRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const selectedTemplate = useMemo(
    () => (selectedId === NEW_TEMPLATE_ID ? null : managedTemplates.find((template) => template.id === selectedId) ?? null),
    [managedTemplates, selectedId],
  );
  const [draft, setDraft] = useState<TemplateDraft | null>(() =>
    selectedTemplate ? createDraft(selectedTemplate) : null,
  );
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [statusMessage, setStatusMessage] = useState("저장됨");
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [isSaveInFlight, setIsSaveInFlight] = useState(false);
  const isCreating = selectedId === NEW_TEMPLATE_ID;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  if (!draft) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 text-zinc-950">
        <div className="grid justify-items-center gap-4">
          <p className="text-sm text-zinc-500">템플릿이 없습니다. 시드 명령을 실행하세요.</p>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
            onClick={() => {
              selectedIdRef.current = NEW_TEMPLATE_ID;
              selectionVersionRef.current += 1;
              draftVersionRef.current += 1;
              setSelectedId(NEW_TEMPLATE_ID);
              setDraft(createNewDraft());
              setSaveState("dirty");
              setStatusMessage("새 템플릿");
              setFormErrors({});
            }}
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            새 템플릿
          </button>
        </div>
      </main>
    );
  }

  const selectTemplate = (template: PromptTemplateRecord) => {
    selectedIdRef.current = template.id;
    selectionVersionRef.current += 1;
    draftVersionRef.current += 1;
    setSelectedId(template.id);
    setDraft(createDraft(template));
    setSaveState("saved");
    setStatusMessage("저장됨");
    setFormErrors({});
  };

  const startNewTemplate = () => {
    selectedIdRef.current = NEW_TEMPLATE_ID;
    selectionVersionRef.current += 1;
    draftVersionRef.current += 1;
    setSelectedId(NEW_TEMPLATE_ID);
    setDraft(createNewDraft());
    setSaveState("dirty");
    setStatusMessage("새 템플릿");
    setFormErrors({});
  };

  const updateDraft = (nextDraft: Partial<TemplateDraft>) => {
    draftVersionRef.current += 1;
    setDraft((currentDraft) => (currentDraft ? { ...currentDraft, ...nextDraft } : currentDraft));
    setSaveState("dirty");
    setStatusMessage("저장되지 않은 변경 사항");
    setFormErrors({});
  };

  const saveTemplate = async () => {
    if (saveInFlightRef.current) {
      return;
    }

    const savingSelectedId = selectedIdRef.current;
    const savingSelectionVersion = selectionVersionRef.current;
    const savingDraftVersion = draftVersionRef.current;
    let variableSchemaJson: unknown;

    try {
      variableSchemaJson = JSON.parse(draft.variableSchemaText);
    } catch {
      setFormErrors({ variableSchemaText: "변수 스키마는 올바른 JSON이어야 합니다." });
      setSaveState("failed");
      setStatusMessage("변수 스키마는 올바른 JSON이어야 합니다.");
      return;
    }

    try {
      const isNewTemplate = savingSelectedId === NEW_TEMPLATE_ID;
      const payload = {
        name: draft.name,
        description: draft.description,
        category: draft.category,
        systemPrompt: draft.systemPrompt,
        variableSchemaJson,
        ...(isNewTemplate ? {} : { isActive: draft.isActive }),
      };
      const validationResult = (
        isNewTemplate ? promptTemplatePayloadSchema : promptTemplateUpdatePayloadSchema
      ).safeParse(payload);

      if (!validationResult.success) {
        setFormErrors(validationErrorsFromIssues(validationResult.error.issues));
        setSaveState("failed");
        setStatusMessage("검증 오류를 수정하세요");
        return;
      }

      setFormErrors({});
      saveInFlightRef.current = true;
      setIsSaveInFlight(true);
      setSaveState("saving");
      setStatusMessage("저장 중");

      const response = await fetch(
        isNewTemplate ? "/api/templates" : `/api/templates/${encodeURIComponent(savingSelectedId)}`,
        {
          method: isNewTemplate ? "POST" : "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(validationResult.data),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to save template");
      }

      const body = (await response.json()) as { template: PromptTemplateRecord };
      const isSameSelection =
        selectedIdRef.current === savingSelectedId && selectionVersionRef.current === savingSelectionVersion;
      const isSameDraft = draftVersionRef.current === savingDraftVersion;

      if (isSameSelection && isSameDraft) {
        setManagedTemplates((currentTemplates) =>
          listVisibleTemplates([
            ...currentTemplates.filter((template) => template.id !== body.template.id),
            body.template,
          ]),
        );
      }

      if (isNewTemplate && isSameSelection) {
        selectedIdRef.current = body.template.id;
        setSelectedId(body.template.id);
      }

      if (
        isSameSelection &&
        isSameDraft
      ) {
        selectedIdRef.current = body.template.id;
        setSelectedId(body.template.id);
        setDraft(createDraft(body.template));
        setSaveState("saved");
        setStatusMessage("저장됨");
      }
    } catch {
      if (
        selectedIdRef.current === savingSelectedId &&
        selectionVersionRef.current === savingSelectionVersion &&
        draftVersionRef.current === savingDraftVersion
      ) {
        setSaveState("failed");
        setStatusMessage("저장 실패");
      }
    } finally {
      saveInFlightRef.current = false;
      setIsSaveInFlight(false);
    }
  };

  const archiveTemplate = async () => {
    if (!selectedTemplate || isCreating) {
      return;
    }

    const archivedTemplateId = selectedTemplate.id;
    setSaveState("saving");
    setStatusMessage("보관 중");

    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(archivedTemplateId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to archive template");
      }

      const remainingTemplates = managedTemplates.filter((template) => template.id !== archivedTemplateId);
      const nextTemplate = remainingTemplates[0] ?? null;
      setManagedTemplates(remainingTemplates);

      selectionVersionRef.current += 1;
      draftVersionRef.current += 1;

      if (nextTemplate) {
        selectedIdRef.current = nextTemplate.id;
        setSelectedId(nextTemplate.id);
        setDraft(createDraft(nextTemplate));
        setSaveState("saved");
        setStatusMessage("보관됨");
      } else {
        selectedIdRef.current = "";
        setSelectedId("");
        setDraft(null);
        setSaveState("saved");
        setStatusMessage("보관됨");
      }
      setFormErrors({});
    } catch {
      setSaveState("failed");
      setStatusMessage("보관 실패");
    }
  };

  return (
    <main className="flex min-h-screen bg-zinc-50 text-zinc-950">
      <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-200 bg-white">
        <header className="border-b border-zinc-200 px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-base font-semibold">프롬프트 템플릿</h1>
            <button
              className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-700 transition-colors hover:bg-zinc-100"
              onClick={startNewTemplate}
              title="새 템플릿"
              type="button"
            >
              <Plus aria-hidden="true" className="size-4" />
              <span className="sr-only">새 템플릿</span>
            </button>
          </div>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            문서 AI 작업에서 사용하는 저장된 프롬프트를 관리합니다.
          </p>
        </header>

        <nav aria-label="프롬프트 템플릿" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ul className="space-y-1">
            {managedTemplates.map((template) => {
              const isSelected = template.id === selectedTemplate?.id;

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
          <div className="flex items-center gap-2">
            {!isCreating && selectedTemplate ? (
              <button
                className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                disabled={isSaveInFlight || saveState === "saving"}
                onClick={archiveTemplate}
                type="button"
              >
                <Archive aria-hidden="true" className="size-4" />
                보관
              </button>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={isSaveInFlight || saveState === "saving" || saveState === "saved"}
              onClick={saveTemplate}
              type="button"
            >
              <Save aria-hidden="true" className="size-4" />
              {isSaveInFlight || saveState === "saving" ? "저장 중..." : "저장"}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <form className="mx-auto grid max-w-5xl gap-5" onSubmit={(event) => event.preventDefault()}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-name">
                이름
              </label>
              <input
                aria-describedby={formErrors.name ? "template-name-error" : undefined}
                aria-invalid={formErrors.name ? "true" : undefined}
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition-colors focus:border-zinc-950"
                id="template-name"
                onChange={(event) => updateDraft({ name: event.target.value })}
                value={draft.name}
              />
              {formErrors.name ? (
                <p className="text-sm text-red-700" id="template-name-error">
                  {formErrors.name}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-description">
                설명
              </label>
              <input
                aria-describedby={formErrors.description ? "template-description-error" : undefined}
                aria-invalid={formErrors.description ? "true" : undefined}
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition-colors focus:border-zinc-950"
                id="template-description"
                onChange={(event) => updateDraft({ description: event.target.value })}
                value={draft.description}
              />
              {formErrors.description ? (
                <p className="text-sm text-red-700" id="template-description-error">
                  {formErrors.description}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-category">
                카테고리
              </label>
              <input
                aria-describedby={formErrors.category ? "template-category-error" : undefined}
                aria-invalid={formErrors.category ? "true" : undefined}
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition-colors focus:border-zinc-950"
                id="template-category"
                onChange={(event) => updateDraft({ category: event.target.value })}
                value={draft.category}
              />
              {formErrors.category ? (
                <p className="text-sm text-red-700" id="template-category-error">
                  {formErrors.category}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-system-prompt">
                시스템 프롬프트
              </label>
              <textarea
                aria-describedby={formErrors.systemPrompt ? "template-system-prompt-error" : undefined}
                aria-invalid={formErrors.systemPrompt ? "true" : undefined}
                className="min-h-56 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none transition-colors focus:border-zinc-950"
                id="template-system-prompt"
                onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                value={draft.systemPrompt}
              />
              {formErrors.systemPrompt ? (
                <p className="text-sm text-red-700" id="template-system-prompt-error">
                  {formErrors.systemPrompt}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="template-variable-schema">
                변수 스키마 JSON
              </label>
              <textarea
                aria-describedby={formErrors.variableSchemaText ? "template-variable-schema-error" : undefined}
                aria-invalid={formErrors.variableSchemaText ? "true" : undefined}
                className="min-h-72 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none transition-colors focus:border-zinc-950"
                id="template-variable-schema"
                onChange={(event) => updateDraft({ variableSchemaText: event.target.value })}
                spellCheck={false}
                value={draft.variableSchemaText}
              />
              {formErrors.variableSchemaText ? (
                <p className="text-sm text-red-700" id="template-variable-schema-error">
                  {formErrors.variableSchemaText}
                </p>
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-zinc-700">
              <input
                checked={draft.isActive}
                className="size-4 accent-zinc-950"
                onChange={(event) => updateDraft({ isActive: event.target.checked })}
                type="checkbox"
              />
              활성
            </label>

            <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">{saveStateLabel[saveState]}</p>
          </form>
        </div>
      </section>
    </main>
  );
}
