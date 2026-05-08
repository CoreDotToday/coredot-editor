import { describe, expect, it } from "vitest";
import { promptTemplatePayloadSchema, validateTemplateVariables } from "./template-validation";

describe("validateTemplateVariables", () => {
  it("returns field-level errors for missing required values", () => {
    const result = validateTemplateVariables(
      {
        fields: [
          { name: "audience", label: "Audience", type: "text", required: true },
          { name: "tone", label: "Tone", type: "select", required: true, options: ["executive"] },
        ],
        required: ["audience", "tone"],
      },
      { audience: "" },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({
      audience: "Audience is required",
      tone: "Tone is required",
    });
  });

  it("treats schema.required fields as required even when the field is not marked required", () => {
    const result = validateTemplateVariables(
      {
        fields: [{ name: "audience", label: "Audience", type: "text", required: false }],
        required: ["audience"],
      },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({
      audience: "Audience is required",
    });
  });
});

describe("promptTemplatePayloadSchema", () => {
  const validPayload = {
    name: "Strategy Review",
    description: "Review strategy",
    category: "strategy_review",
    systemPrompt: "You are a strategy editor.",
    variableSchemaJson: {
      fields: [
        { name: "audience", label: "Audience", type: "text" as const, required: true },
        {
          name: "tone",
          label: "Tone",
          type: "select" as const,
          required: false,
          options: ["executive", "direct"],
        },
      ],
      required: ["audience"],
    },
  };

  it("rejects required variable names that are not declared fields", () => {
    const result = promptTemplatePayloadSchema.safeParse({
      ...validPayload,
      variableSchemaJson: {
        ...validPayload.variableSchemaJson,
        required: ["missing"],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate variable field names", () => {
    const result = promptTemplatePayloadSchema.safeParse({
      ...validPayload,
      variableSchemaJson: {
        fields: [
          { name: "audience", label: "Audience", type: "text" as const, required: true },
          { name: "audience", label: "Audience duplicate", type: "textarea" as const, required: false },
        ],
        required: ["audience"],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects select variable fields without options", () => {
    const result = promptTemplatePayloadSchema.safeParse({
      ...validPayload,
      variableSchemaJson: {
        fields: [{ name: "tone", label: "Tone", type: "select" as const, required: false }],
        required: [],
      },
    });

    expect(result.success).toBe(false);
  });
});
