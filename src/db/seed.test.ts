import { describe, expect, it } from "vitest";
import { defaultPromptTemplates } from "./seed";

describe("defaultPromptTemplates", () => {
  it("ships business strategy templates with editable prompt variables", () => {
    expect(defaultPromptTemplates).toHaveLength(3);
    expect(defaultPromptTemplates.map((template) => template.category)).toEqual([
      "strategy_review",
      "executive_rewrite",
      "market_research",
    ]);
    expect(defaultPromptTemplates[0]?.variableSchema.required).toContain("audience");
    expect(defaultPromptTemplates[0]?.systemPrompt).toContain("business strategy editor");
  });
});
