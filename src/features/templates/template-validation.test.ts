import { describe, expect, it } from "vitest";
import { validateTemplateVariables } from "./template-validation";

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
});
