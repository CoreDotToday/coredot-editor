"use client";

import type { PromptTemplateRecord } from "@/db/schema";

export type PromptTemplateOption = Pick<PromptTemplateRecord, "id" | "name" | "category" | "variableSchemaJson">;

type PromptTemplatePanelProps = {
  selectedTemplateId: string;
  templates: PromptTemplateOption[];
  variableErrors: Record<string, string>;
  variableValues: Record<string, string>;
  onSelectTemplate: (templateId: string) => void;
  onVariableChange: (name: string, value: string) => void;
};

export function PromptTemplatePanel({
  onSelectTemplate,
  onVariableChange,
  selectedTemplateId,
  templates,
  variableErrors,
  variableValues,
}: PromptTemplatePanelProps) {
  const templateGroups = templates.reduce<Record<string, PromptTemplateOption[]>>((groups, template) => {
    const group = groups[template.category] ?? [];
    group.push(template);
    groups[template.category] = group;
    return groups;
  }, {});
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  const variableFields = selectedTemplate?.variableSchemaJson.fields ?? [];

  return (
    <section className="min-h-0 flex-1 overflow-y-auto border-b border-zinc-200 px-4 py-5">
      <h2 className="text-sm font-semibold text-zinc-950">Templates</h2>
      {templates.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-zinc-500">No active templates.</p>
      ) : (
        <div className="mt-3 space-y-5">
          <div aria-label="Prompt template" className="space-y-5" role="radiogroup">
            {Object.entries(templateGroups).map(([category, categoryTemplates]) => (
              <div key={category}>
                <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">{category}</h3>
                <ul className="mt-2 space-y-1">
                  {categoryTemplates.map((template) => {
                    const isSelected = template.id === selectedTemplateId;

                    return (
                      <li key={template.id}>
                        <button
                          aria-checked={isSelected}
                          className={[
                            "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                            isSelected
                              ? "bg-zinc-950 text-white"
                              : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950",
                          ].join(" ")}
                          onClick={() => onSelectTemplate(template.id)}
                          role="radio"
                          type="button"
                        >
                          {template.name}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {variableFields.length > 0 ? (
            <div className="border-t border-zinc-200 pt-4">
              <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">Variables</h3>
              <div className="mt-3 space-y-3">
                {variableFields.map((field) => {
                  const value = variableValues[field.name] ?? "";
                  const error = variableErrors[field.name] ?? "";
                  const fieldId = `prompt-variable-${field.name}`;

                  return (
                    <div key={field.name}>
                      <label className="block text-xs font-medium text-zinc-700" htmlFor={fieldId}>
                        {field.label}
                      </label>
                      {field.type === "textarea" ? (
                        <textarea
                          aria-invalid={error ? "true" : "false"}
                          className="mt-1 min-h-20 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-950 outline-none transition-colors focus:border-zinc-500"
                          id={fieldId}
                          onChange={(event) => onVariableChange(field.name, event.currentTarget.value)}
                          value={value}
                        />
                      ) : field.type === "select" ? (
                        <select
                          aria-invalid={error ? "true" : "false"}
                          className="mt-1 h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-950 outline-none transition-colors focus:border-zinc-500"
                          id={fieldId}
                          onChange={(event) => onVariableChange(field.name, event.currentTarget.value)}
                          value={value}
                        >
                          <option value="">Select...</option>
                          {(field.options ?? []).map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-invalid={error ? "true" : "false"}
                          className="mt-1 h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-950 outline-none transition-colors focus:border-zinc-500"
                          id={fieldId}
                          onChange={(event) => onVariableChange(field.name, event.currentTarget.value)}
                          value={value}
                        />
                      )}
                      {error ? <p className="mt-1 text-xs text-rose-700">{error}</p> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
