import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeAiRunWithProposals, createAiRun } from "@/features/ai/ai-run-repository";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById, getDocumentsByIds } from "@/features/documents/document-repository";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentById: vi.fn(),
  getDocumentsByIds: vi.fn(async () => []),
}));

vi.mock("@/features/templates/template-repository", () => ({
  getPromptTemplateById: vi.fn(),
}));

vi.mock("@/features/ai/ai-run-repository", () => ({
  completeAiRunWithProposals: vi.fn(async (_scope, id, outputText, proposals) => ({
    run: { id, outputText, status: "completed" },
    proposals: proposals.map((proposal: Record<string, unknown>, index: number) => ({
      id: `proposal_${index + 1}`,
      status: "pending",
      ...proposal,
    })),
  })),
  createAiRun: vi.fn(async (_scope, input) => ({ id: "run_1", ...input, status: "pending" })),
  failAiRun: vi.fn(),
}));

const localWorkspace = { workspaceId: "local" };

vi.mock("@/features/ai/ai-settings-repository", () => ({
  getAiSettings: vi.fn(async () => ({
    aiBaseUrl: null,
    aiMaxCompletionTokens: null,
    aiModel: "stub-editor",
    aiProvider: "stub",
    aiReasoningEffort: null,
    id: "default",
    workspaceId: "local",
  })),
}));

vi.mock("@/features/ai/providers", () => ({
  createAiProvider: vi.fn(() => ({
    name: "stub",
    model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
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
        {
          problem: "Missing source",
          reason: "The target does not appear in the document.",
          targetText: "missing target",
          replacementText: "replacement",
        },
      ],
    })),
  })),
}));

const documentRecord = {
  id: "doc_1",
  workspaceId: "local",
  title: "Memo",
  plainText: "growth was good and someone should follow up",
  contentJson: { type: "doc" },
  metadataJson: {},
  readiness: "draft",
  status: "draft",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DocumentRecord;

const templateRecord = {
  id: "tpl_1",
  workspaceId: "local",
  builtinKey: null,
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(await response.json()).toEqual({
      error: "Invalid template variables",
      details: { audience: "Audience 필드는 필수입니다." },
    });
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
      skippedProposalCount: 1,
    });
    expect(createAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({ commandType: "document_review" }),
    );
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      expect.stringContaining("Two findings."),
      expect.arrayContaining([
        expect.objectContaining({ occurrenceIndex: 0, targetText: "growth was good" }),
        expect.objectContaining({ occurrenceIndex: 0, targetText: "someone should follow up" }),
      ]),
    );
  });

  it("hydrates referenced documents by id before building the review prompt", async () => {
    const generateReview = vi.fn(async () => ({ summary: "No findings.", findings: [] }));
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getDocumentsByIds).mockResolvedValueOnce([
      {
        ...documentRecord,
        id: "doc_ref",
        title: "Reference Memo",
        plainText: "Reference memo body",
      },
    ]);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
      generateText: vi.fn(),
      streamText: vi.fn(),
      generateReview,
    });

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review with references",
        variables: {},
        references: { documents: [{ documentId: "doc_ref", text: "client text must be ignored" }] },
      }),
    );

    expect(response.status).toBe(200);
    expect(getDocumentsByIds).toHaveBeenCalledWith(localWorkspace, ["doc_ref"]);
    expect(generateReview).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    });
    expect(generateReview).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.not.stringContaining("client text must be ignored"),
        }),
      ]),
    });
    expect(createAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        inputSummaryJson: expect.objectContaining({
          referencedDocumentIds: ["doc_ref"],
        }),
      }),
    );
  });

  it("excludes the current document from referenced review context", async () => {
    const generateReview = vi.fn(async () => ({ summary: "No findings.", findings: [] }));
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getDocumentsByIds).mockResolvedValueOnce([
      {
        ...documentRecord,
        id: "doc_ref",
        title: "Reference Memo",
        plainText: "Reference memo body",
      },
    ]);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
      capabilities: {
        coreTodayProxy: false,
        reasoningEffort: false,
        streaming: "buffered",
        structuredReview: true,
      },
      generateText: vi.fn(),
      streamText: vi.fn(),
      generateReview,
    });

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review with references",
        variables: {},
        references: {
          documents: [
            { documentId: "doc_1", titleSnapshot: "Self reference" },
            { documentId: "doc_ref", titleSnapshot: "Reference snapshot" },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(getDocumentsByIds).toHaveBeenCalledWith(localWorkspace, ["doc_ref"]);
    expect(generateReview).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    });
    expect(generateReview).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.not.stringContaining("Self reference"),
        }),
      ]),
    });
    expect(createAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        inputSummaryJson: expect.objectContaining({
          referencedDocumentIds: ["doc_ref"],
        }),
      }),
    );
  });

  it("validates generated findings against submitted document text", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "persisted stale body",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
      generateText: vi.fn(),
      streamText: vi.fn(),
      generateReview: vi.fn(async () => ({
        summary: "Draft finding.",
        findings: [
          {
            problem: "Draft wording",
            reason: "The submitted draft contains this text.",
            targetText: "fresh edited body",
            replacementText: "fresh edited body with clearer owner",
          },
        ],
      })),
    });

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review",
        variables: {},
        documentText: "fresh edited body",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      proposals: [{ targetText: "fresh edited body" }],
      skippedProposalCount: 0,
    });
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      expect.stringContaining("Draft finding."),
      [expect.objectContaining({ targetText: "fresh edited body" })],
    );
  });

  it("reviews an explicitly empty submitted draft instead of falling back to stale persisted text", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review",
        variables: {},
        documentText: "",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      proposals: [],
      skippedProposalCount: 3,
    });
    expect(createAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({ inputSummaryJson: expect.objectContaining({ documentTextLength: 0 }) }),
    );
  });

  it("completes reviews with skipped findings when none are safely applicable", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
      generateText: vi.fn(),
      streamText: vi.fn(),
      generateReview: vi.fn(async () => ({
        summary: "Findings were ambiguous.",
        findings: [
          {
            problem: "Duplicate sentence",
            reason: "The target does not appear exactly once.",
            targetText: "missing target",
            replacementText: "safe replacement",
          },
        ],
      })),
    });

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
      review: { summary: "Findings were ambiguous." },
      proposals: [],
      skippedProposalCount: 1,
    });
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      expect.stringContaining("Findings were ambiguous."),
      [],
    );
  });

  it("returns 500 when provider configuration is invalid before a run exists", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockImplementationOnce(() => {
      throw new Error("Unsupported AI_PROVIDER: bad");
    });

    const response = await POST(
      createJsonRequest({
        documentId: "doc_1",
        templateId: "tpl_1",
        command: "Review",
        variables: {},
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AI generation failed" });
    expect(createAiRun).not.toHaveBeenCalled();
  });
});
