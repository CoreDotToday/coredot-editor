import type { PromptVariableSchema } from "@/db/schema";

export type TemplateVariableValidation =
  | { ok: true; errors: Record<string, never> }
  | { ok: false; errors: Record<string, string> };

export function validateTemplateVariables(
  schema: PromptVariableSchema,
  values: Record<string, unknown>,
): TemplateVariableValidation {
  const errors: Record<string, string> = {};
  const requiredFields = new Set(schema.required);

  for (const field of schema.fields) {
    const value = values[field.name];
    const isMissing = value === undefined || value === null || String(value).trim() === "";
    if ((field.required || requiredFields.has(field.name)) && isMissing) {
      errors[field.name] = `${field.label} is required`;
    }
  }

  return Object.keys(errors).length === 0 ? { ok: true, errors: {} } : { ok: false, errors };
}
