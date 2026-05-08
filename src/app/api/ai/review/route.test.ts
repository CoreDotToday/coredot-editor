import { describe, expect, it, vi } from "vitest";
import { completeAiRun, createAiRun } from "@/features/ai/ai-run-repository";
import { createProposal } from "@/features/proposals/proposal-repository";
import { getDocumentById } from "@/features/documents/document-repository";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentById: vi.fn(),
}));

vi.mock("@/features/templates/template-repository", () => ({
  getPromptTemplateById: vi.fn(),
}));

vi.mock("@/features/ai/ai-run-repository", () => ({
  completeAiRun: vi.fn(async (id, outputText) => ({ id, outputText, status: "completed" })),
  createAiRun: vi.fn(async (input) => ({ id: "run_1", ...input, status: "pending" })),
  failAiRun: vi.fn(),
}));

vi.mock("@/features/proposals/proposal-repository", () => ({
  createProposal: vi.fn(async (input) => ({ id: `proposal_${input.targetText}`, status: "pending", ...input })),
}));

vi.mock("@/features/ai/providers", () => ({
  createAiProvider: vi.fn(() => ({
    name: "stub",
    model: "stub-editor",
    generateReview: vi.fn(async () => ({
      summary: "Two findings.",
      findings: [
        {
          problem: "Unclear metric",
          reason: "Specificity helps review.",
          targetText: "growth was good",
          replacementText: "revenue grew 8%",
        },
        {
          problem: "Weak owner",
          reason: "Ownership helps execution.",
          targetText: "someone should follow up",
          replacementText: "Sales Ops should follow up",
        },
      ],
    })),
  })),
}));

const documentRecord = {
  id: "doc_1",
  title: "Memo",
  plainText: "growth was good and someone should follow up",
  contentJson: { type: "doc" },
  status: "draft",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DocumentRecord;

const templateRecord = {
  id: "tpl_1",
  name: "Review",
  description: "Review",
  category: "review",
  systemPrompt: "Review document.",
  variableSchemaJson: { fields: [], required: [] },
  isDefault: false,
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies PromptTemplateRecord;

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/ai/review", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/review", () => {
  it("returns 400 when required template variables are missing", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce({
      ...templateRecord,
      variableSchemaJson: {
        fields: [{ name: "audience", label: "Audience", type: "text", required: true }],
        required: ["audience"],
      },
    });

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review",
        variables: {},
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid template variables", details: { audience: "Audience is required" } });
    expect(createAiRun).not.toHaveBeenCalled();
  });

  it("creates pending proposals for every structured finding", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review",
        variables: {},
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { id: "run_1", status: "completed" },
      review: { summary: "Two findings." },
      proposals: [{ targetText: "growth was good" }, { targetText: "someone should follow up" }],
    });
    expect(createAiRun).toHaveBeenCalledWith(expect.objectContaining({ commandType: "document_review" }));
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(completeAiRun).toHaveBeenCalledWith("run_1", expect.stringContaining("Two findings."));
  });
});
