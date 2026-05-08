import { describe, expect, it, vi } from "vitest";
import { getDocumentById } from "@/features/documents/document-repository";
import { createAiProvider } from "@/features/ai/providers";
import { completeAiRun, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { createProposal } from "@/features/proposals/proposal-repository";
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
  failAiRun: vi.fn(async (id, errorMessage) => ({ id, errorMessage, status: "failed" })),
}));

vi.mock("@/features/proposals/proposal-repository", () => ({
  createProposal: vi.fn(async (input) => ({ id: "proposal_1", status: "pending", ...input })),
}));

vi.mock("@/features/ai/providers", () => ({
  createAiProvider: vi.fn(() => ({
    name: "stub",
    model: "stub-editor",
    generateText: vi.fn(async () => "Improved text"),
  })),
}));

const documentRecord = {
  id: "doc_1",
  title: "Memo",
  plainText: "Old text in a document",
  contentJson: { type: "doc" },
  status: "draft",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DocumentRecord;

const templateRecord = {
  id: "tpl_1",
  name: "Rewrite",
  description: "Rewrite",
  category: "rewrite",
  systemPrompt: "Rewrite selected text.",
  variableSchemaJson: {
    fields: [{ name: "audience", label: "Audience", type: "text", required: true }],
    required: ["audience"],
  },
  isDefault: false,
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies PromptTemplateRecord;

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/ai/rewrite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validBody = {
  documentId: "doc_1",
  templateId: "tpl_1",
  command: "Rewrite for clarity",
  variables: { audience: "board" },
  selectedText: "Old text",
  beforeContext: "",
  afterContext: "in a document",
};

describe("POST /api/ai/rewrite", () => {
  it("returns 400 for bad JSON without touching repositories", async () => {
    const response = await POST(new Request("http://localhost/api/ai/rewrite", { method: "POST", body: "{" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(getDocumentById).not.toHaveBeenCalled();
  });

  it("returns 404 when the document is missing", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as never);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Document not found" });
  });

  it("creates a completed AI run and pending proposal for selected text", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { id: "run_1", status: "completed" },
      proposal: {
        id: "proposal_1",
        aiRunId: "run_1",
        documentId: "doc_1",
        targetText: "Old text",
        replacementText: "Improved text",
        status: "pending",
      },
    });
    expect(createAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: "selection_rewrite",
        documentId: "doc_1",
        promptTemplateId: "tpl_1",
        provider: "stub",
        model: "stub-editor",
      }),
    );
    expect(completeAiRun).toHaveBeenCalledWith("run_1", "Improved text");
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        aiRunId: "run_1",
        targetText: "Old text",
        replacementText: "Improved text",
      }),
    );
  });

  it("marks the AI run failed when generation throws", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
      generateText: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AI generation failed" });
    expect(failAiRun).toHaveBeenCalledWith("run_1", "provider unavailable");
  });
});
