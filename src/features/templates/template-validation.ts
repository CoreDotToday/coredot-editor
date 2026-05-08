import { z } from "zod";
import type { PromptVariableSchema } from "@/db/schema";

const variableFieldSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["text", "textarea", "select"]),
    required: z.boolean(),
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((field, context) => {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Select fields require at least one option",
        path: ["options"],
      });
    }
  });

export const promptVariableSchema = z
  .object({
    fields: z.array(variableFieldSchema),
    required: z.array(z.string().min(1)),
  })
  .superRefine((schema, context) => {
    const fieldNames = new Set<string>();

    schema.fields.forEach((field, index) => {
      if (fieldNames.has(field.name)) {
        context.addIssue({
          code: "custom",
          message: "Variable field names must be unique",
          path: ["fields", index, "name"],
        });
      }

      fieldNames.add(field.name);
    });

    schema.required.forEach((requiredField, index) => {
      if (!fieldNames.has(requiredField)) {
        context.addIssue({
          code: "custom",
          message: "Required variables must be declared fields",
          path: ["required", index],
        });
      }
    });
  });

export const promptTemplatePayloadSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().min(1, "Description is required"),
  category: z.string().trim().min(1, "Category is required"),
  systemPrompt: z.string().trim().min(1, "System prompt is required"),
  variableSchemaJson: promptVariableSchema,
});

export const promptTemplateUpdatePayloadSchema = promptTemplatePayloadSchema.extend({
  isActive: z.boolean(),
});

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
