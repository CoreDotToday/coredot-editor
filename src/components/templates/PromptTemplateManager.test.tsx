import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptTemplateManager } from "./PromptTemplateManager";

describe("PromptTemplateManager", () => {
  it("renders editable template fields", () => {
    render(
      <PromptTemplateManager
        templates={[
          {
            id: "tpl_1",
            name: "Strategy Review",
            description: "Review strategy",
            category: "strategy_review",
            systemPrompt: "You are a strategy editor.",
            variableSchemaJson: { fields: [], required: [] },
            isDefault: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]}
      />,
    );

    expect(screen.getByDisplayValue("Strategy Review")).toBeInTheDocument();
    expect(screen.getByDisplayValue("You are a strategy editor.")).toBeInTheDocument();
  });
});
