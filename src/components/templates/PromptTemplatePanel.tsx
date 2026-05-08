"use client";

import type { PromptTemplateRecord } from "@/db/schema";

export type PromptTemplateOption = Pick<PromptTemplateRecord, "id" | "name" | "category">;

type PromptTemplatePanelProps = {
  selectedTemplateId: string;
  templates: PromptTemplateOption[];
  onSelectTemplate: (templateId: string) => void;
};

export function PromptTemplatePanel({ onSelectTemplate, selectedTemplateId, templates }: PromptTemplatePanelProps) {
  const templateGroups = templates.reduce<Record<string, PromptTemplateOption[]>>((groups, template) => {
    const group = groups[template.category] ?? [];
    group.push(template);
    groups[template.category] = group;
    return groups;
  }, {});

  return (
    <section className="min-h-0 flex-1 overflow-y-auto border-b border-zinc-200 px-4 py-5">
      <h2 className="text-sm font-semibold text-zinc-950">Templates</h2>
      {templates.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-zinc-500">No active templates.</p>
      ) : (
        <div aria-label="Prompt template" className="mt-3 space-y-5" role="radiogroup">
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
      )}
    </section>
  );
}
