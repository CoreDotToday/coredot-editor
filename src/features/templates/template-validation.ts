import type { PromptVariableSchema } from "@/db/schema";

export type TemplateVariableValidation =
  | { ok: true; errors: Record<string, never> }
  | { ok: false; errors: Record<string, string> };

export function validateTemplateVariables(
  schema: PromptVariableSchema,
  values: Record<string, unknown>,
): TemplateVariableValidation {
  const errors: Record<string, string> = {};

  for (const field of schema.fields) {
    const value = values[field.name];
    const isMissing = value === undefined || value === null || String(value).trim() === "";
    if (field.required && isMissing) {
      errors[field.name] = `${field.label} is required`;
    }
  }

  return Object.keys(errors).length === 0 ? { ok: true, errors: {} } : { ok: false, errors };
}
