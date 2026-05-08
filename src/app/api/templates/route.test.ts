import { describe, expect, it, vi } from "vitest";
import { createPromptTemplate } from "@/features/templates/template-repository";
import { POST } from "./route";

vi.mock("@/features/templates/template-repository", () => ({
  createPromptTemplate: vi.fn(async (input) => ({
    id: "tpl_created",
    ...input,
    isDefault: false,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
  listPromptTemplates: vi.fn(),
}));

const validBody = {
  name: "Strategy Review",
  description: "Review strategy",
  category: "strategy_review",
  systemPrompt: "You are a strategy editor.",
  variableSchemaJson: {
    fields: [{ name: "audience", label: "Audience", type: "text", required: true }],
    required: ["audience"],
  },
};

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/templates", () => {
  it("returns 400 for an invalid variable schema", async () => {
    const response = await POST(
      createJsonRequest({
        ...validBody,
        variableSchemaJson: {
          fields: [{ name: "tone", label: "Tone", type: "select", required: false }],
          required: ["missing"],
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(createPromptTemplate).not.toHaveBeenCalled();
  });
});
