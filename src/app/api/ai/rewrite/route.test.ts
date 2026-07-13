import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentById, getDocumentsByIds } from "@/features/documents/document-repository";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import {
  claimAiRun,
  completeAiRunWithProposals,
  failAiRun,
  getAiRunByIdempotencyKey,
} from "@/features/ai/ai-run-repository";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { createAiOperationFingerprint } from "@/features/ai/ai-execution";
import { aiCommandPayloadSchema } from "@/features/ai/types";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentById: vi.fn(),
  getDocumentsByIds: vi.fn(async () => []),
}));

vi.mock("@/features/templates/template-repository", () => ({
  getPromptTemplateById: vi.fn(),
}));

vi.mock("@/features/ai/ai-run-repository", () => ({
  claimAiRun: vi.fn(async (_scope, input) => ({
    kind: "claimed",
    run: { executionToken: "attempt-token-1", id: "run_1", ...input, status: "pending" },
  })),
  completeAiRunWithProposals: vi.fn(async (_scope, id, _executionToken, outputText, proposals) => ({
    run: {
      commandType: "selection_rewrite",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id,
      idempotencyKey: "must-not-leak",
      inputSummaryJson: { prompt: "must-not-leak" },
      operationFingerprint: "must-not-leak",
      outputText,
      status: "completed",
      workspaceId: "must-not-leak",
    },
    proposals: proposals.map((proposal: Record<string, unknown>, index: number) => ({
      id: `proposal_${index + 1}`,
      status: "pending",
      ...proposal,
    })),
  })),
  createAiRun: vi.fn(async (_scope, input) => ({ id: "run_1", ...input, status: "pending" })),
  failAiRun: vi.fn(async (_scope, id, _executionToken, errorMessage) => ({ id, errorMessage, status: "failed" })),
  getAiRunByIdempotencyKey: vi.fn(async () => null),
}));

const localWorkspace = TEST_REQUEST_CONTEXT;

vi.mock("@/features/ai/ai-settings-repository", () => ({
  getAiSettings: vi.fn(async () => ({
    aiBaseUrl: null,
    aiMaxCompletionTokens: null,
    aiModel: "stub-editor",
    aiProvider: "stub",
    aiReasoningEffort: null,
    id: "default",
    workspaceId: "vitest-workspace",
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
    generateText: vi.fn(async () => "Improved text"),
  })),
}));

const documentRecord = {
  id: "doc_1",
  workspaceId: "vitest-workspace",
  creationKey: null,
  title: "Memo",
  plainText: "Old text in a document",
  contentJson: { type: "doc" },
  metadataJson: {},
  readiness: "draft",
  revision: 0,
  status: "draft",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DocumentRecord;

const templateRecord = {
  id: "tpl_1",
  workspaceId: "vitest-workspace",
  builtinKey: null,
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

function createJsonRequest(body: unknown, idempotencyKey?: string) {
  return new Request("http://localhost/api/ai/rewrite", {
    method: "POST",
    headers: idempotencyKey === undefined ? undefined : { "Idempotency-Key": idempotencyKey },
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
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("rejects a malformed idempotency header before budget, preflight, or provider work", async () => {
    const consume = vi.fn(async () => ({
      allowed: true,
      limit: 20,
      remaining: 19,
      retryAt: new Date(Date.now() + 60_000),
    }));
    setRequestBudgetForTests({ consume });

    const response = await POST(createJsonRequest(validBody, "invalid key"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Idempotency-Key header" });
    expect(consume).not.toHaveBeenCalled();
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns a bounded in-progress conflict without starting provider execution", async () => {
    const normalized = aiCommandPayloadSchema.parse(validBody);
    const operationFingerprint = await createAiOperationFingerprint("rewrite", {
      ...normalized,
      documentTextSource: "persisted",
    });
    vi.mocked(getAiRunByIdempotencyKey).mockResolvedValueOnce({
      proposals: [],
      run: {
        id: "run_in_progress",
        idempotencyKey: "rewrite-key",
        operationFingerprint,
        status: "pending",
      },
    } as never);

    const response = await POST(createJsonRequest(validBody, "rewrite-key"));

    expect(response.status).toBe(409);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      code: "ai_operation_in_progress",
      error: "AI operation is already in progress",
    });
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("replays the exact durable rewrite with the same safe public run shape", async () => {
    const normalized = aiCommandPayloadSchema.parse(validBody);
    const operationFingerprint = await createAiOperationFingerprint("rewrite", {
      ...normalized,
      documentTextSource: "persisted",
    });
    vi.mocked(getAiRunByIdempotencyKey).mockResolvedValueOnce({
      proposals: [{
        appliedMode: null,
        command: validBody.command,
        defaultApplyMode: "replace",
        explanation: "Durable explanation.",
        id: "durable_proposal",
        occurrenceIndex: null,
        replacementText: "Durable replacement",
        source: "selection",
        status: "pending",
        targetFrom: null,
        targetText: validBody.selectedText,
        targetTo: null,
      }],
      run: {
        commandType: "selection_rewrite",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        id: "durable_run",
        idempotencyKey: "rewrite-replay-key",
        inputSummaryJson: { prompt: "must-not-leak" },
        operationFingerprint,
        outputText: "Durable replacement",
        status: "completed",
        workspaceId: "must-not-leak",
      },
    } as never);

    const response = await POST(createJsonRequest(validBody, "rewrite-replay-key"));
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(responseBody).toMatchObject({
      proposal: { id: "durable_proposal", replacementText: "Durable replacement" },
      run: { id: "durable_run", status: "completed" },
    });
    expect(Object.keys(responseBody.run).sort()).toEqual(["commandType", "createdAt", "id", "status"]);
    expect(JSON.stringify(responseBody)).not.toMatch(/must-not-leak|rewrite-replay-key|operationFingerprint|idempotencyKey|workspaceId|inputSummaryJson/);
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 429 without reading the request body when the budget is exhausted", async () => {
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 20,
        remaining: 0,
        retryAt: new Date(Date.now() + 5_000),
      })),
    });
    const read = vi.fn();
    const response = await POST({
      body: { getReader: () => ({ read }) },
      headers: new Headers({ "content-length": "128", "Idempotency-Key": "budget-key" }),
    } as unknown as Request);

    expect(response.status).toBe(429);
    expect(read).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("rejects an oversized submitted AI body before JSON parsing or provider work", async () => {
    const json = vi.fn();
    const request = {
      headers: new Headers({ "content-length": String(RESOURCE_LIMITS.documentJsonBytes + 1024 * 1024 + 1) }),
      json,
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 504, aborts the provider, and does not persist a proposal after timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generateText = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      markStarted?.();
      return new Promise<string>((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
      });
    });
    vi.mocked(createAiProvider).mockReturnValueOnce({
      capabilities: { coreTodayProxy: false, reasoningEffort: false, streaming: "buffered", structuredReview: true },
      generateReview: vi.fn(),
      generateText,
      model: "stub-editor",
      name: "stub",
      streamText: vi.fn(),
    });

    try {
      const pending = POST(createJsonRequest(validBody));
      await started;
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(generateText.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      expect(failAiRun).toHaveBeenCalledWith(
        TEST_REQUEST_CONTEXT,
        "run_1",
        "attempt-token-1",
        "Operation timed out",
        { retryNotBeforeAt: expect.any(Date) },
      );
      expect(completeAiRunWithProposals).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("returns 404 when a second principal requests AI work for another workspace's document", async () => {
    const workspaceBContext = {
      ...TEST_REQUEST_CONTEXT,
      principalId: "principal-b",
      requestId: "request-b",
      workspaceId: "workspace-b",
    };
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => workspaceBContext,
    });
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as never);

    const response = await POST(createJsonRequest({ ...validBody, documentId: "workspace-a-document" }));

    expect(response.status).toBe(404);
    expect(getDocumentById).toHaveBeenCalledWith(workspaceBContext, "workspace-a-document");
    expect(getAiSettings).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 404 when the template is missing before selected text validation", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text appears twice. Old text appears twice.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(null as never);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Template not found" });
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("creates a completed AI run and pending proposal for selected text", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      run: { id: "run_1", status: "completed" },
      proposal: {
        id: "proposal_1",
        targetText: "Old text",
        replacementText: "Improved text",
        status: "pending",
      },
    });
    expect(Object.keys(responseBody.run).sort()).toEqual(["commandType", "createdAt", "id", "status"]);
    expect(JSON.stringify(responseBody)).not.toMatch(/must-not-leak|operationFingerprint|idempotencyKey|workspaceId|inputSummaryJson/);
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        commandType: "selection_rewrite",
        documentId: "doc_1",
        promptTemplateId: "tpl_1",
        provider: "stub",
        model: "stub-editor",
      }),
    );
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          targetText: "Old text",
          replacementText: "Improved text",
        }),
      ],
    );
  });

  it("hydrates referenced documents by id before building the rewrite prompt", async () => {
    const generateText = vi.fn(async () => "Improved text");
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
      generateText,
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(
      createJsonRequest({
        ...validBody,
        references: { documents: [{ documentId: "doc_ref", text: "client text must be ignored" }] },
      }),
    );

    expect(response.status).toBe(200);
    expect(getDocumentsByIds).toHaveBeenCalledWith(localWorkspace, ["doc_ref"]);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.not.stringContaining("client text must be ignored"),
        }),
      ]),
    }));
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        inputSummaryJson: expect.objectContaining({
          referencedDocumentIds: ["doc_ref"],
        }),
      }),
    );
  });

  it("excludes the current document from referenced rewrite context", async () => {
    const generateText = vi.fn(async () => "Improved text");
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
      generateText,
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(
      createJsonRequest({
        ...validBody,
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
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.not.stringContaining("Self reference"),
        }),
      ]),
    }));
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        inputSummaryJson: expect.objectContaining({
          referencedDocumentIds: ["doc_ref"],
        }),
      }),
    );
  });

  it("uses a selection-rewrite system prompt even when the selected template is a review template", async () => {
    const generateText = vi.fn(async () => "Improved text");
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce({
      ...templateRecord,
      category: "contract_review",
      name: "Contract Review",
      systemPrompt: "Return only the structured review result requested by the API schema.",
    });
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
      generateText,
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Selection rewrite mode"),
        }),
      ]),
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Return only a compact JSON object"),
        }),
      ]),
    }));
  });

  it("extracts replacement text if a model returns a structured review JSON during selection rewrite", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce({
      ...templateRecord,
      category: "contract_review",
      name: "Contract Review",
      systemPrompt: "Return only the structured review result requested by the API schema.",
    });
    vi.mocked(createAiProvider).mockReturnValueOnce({
      name: "stub",
      model: "stub-editor",
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
      generateText: vi.fn(async () =>
        JSON.stringify({
          findings: [
            {
              problem: "Ambiguity",
              reason: "The wording is underspecified.",
              targetText: "Old text",
              replacementText: "Old text with objective written evidence requirements.",
            },
          ],
          summary: "One issue.",
        }),
      ),
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Old text with objective written evidence requirements.",
      [
        expect.objectContaining({
          explanation: "The wording is underspecified.",
          replacementText: "Old text with objective written evidence requirements.",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("persists explanation when a model returns structured rewrite JSON", async () => {
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
      generateText: vi.fn(async () =>
        JSON.stringify({
          explanation: "Clarifies ownership and removes vague wording.",
          replacementText: "Old text with clearer ownership.",
        }),
      ),
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Old text with clearer ownership.",
      [
        expect.objectContaining({
          explanation: "Clarifies ownership and removes vague wording.",
          replacementText: "Old text with clearer ownership.",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("parses fenced structured rewrite JSON", async () => {
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
      generateText: vi.fn(async () =>
        [
          "```json",
          JSON.stringify({
            explanation: "Makes the selected sentence more direct.",
            replacementText: "Old text stated directly.",
          }),
          "```",
        ].join("\n"),
      ),
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Old text stated directly.",
      [
        expect.objectContaining({
          explanation: "Makes the selected sentence more direct.",
          replacementText: "Old text stated directly.",
        }),
      ],
    );
  });

  it("keeps plain text rewrite responses backward compatible with a fallback explanation", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          explanation: "AI rewrite suggestion.",
          replacementText: "Improved text",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("treats continue writing as an insert-below continuation command", async () => {
    const generateText = vi.fn(async () => "Next paragraph that continues the selected context.");
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
      generateText,
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest({ ...validBody, command: "Continue writing" }));

    expect(response.status).toBe(200);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Write only new continuation text"),
        }),
      ]),
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not repeat the selected text"),
        }),
      ]),
    }));
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Next paragraph that continues the selected context.",
      [
        expect.objectContaining({
          command: "Continue writing",
          defaultApplyMode: "insert_below",
          replacementText: "Next paragraph that continues the selected context.",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("treats document-output commands as insert-below proposals", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({ ...validBody, command: "Summarize document" }));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          command: "Summarize document",
          defaultApplyMode: "insert_below",
          replacementText: "Improved text",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("validates selected text against the reviewed draft text when provided", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Stale saved text",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(
      createJsonRequest({
        ...validBody,
        documentText: "Unsaved draft has Old text once",
      }),
    );

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          targetText: "Old text",
        }),
      ],
    );
  });

  it("returns 400 when selected text is not an exact unique match in the document", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text appears twice. Old text appears twice.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected text must match exactly once in the document" });
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("allows repeated selected text when a valid occurrence index is provided", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text appears twice. Old text appears twice.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({ ...validBody, occurrenceIndex: 1 }));

    expect(response.status).toBe(200);
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          command: "Rewrite for clarity",
          defaultApplyMode: "replace",
          source: "selection",
          targetText: "Old text",
        }),
      ],
    );
  });

  it("validates selected text against an explicitly empty submitted draft", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text appears in the stale saved document.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({ ...validBody, documentText: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected text must match exactly once in the document" });
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("persists captured selection range metadata on selection proposals", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(
      createJsonRequest({
        ...validBody,
        selectionRange: { from: 1, to: 9 },
      }),
    );

    expect(response.status).toBe(200);
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        inputSummaryJson: expect.objectContaining({
          selectionRange: { from: 1, to: 9 },
        }),
      }),
    );
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          targetFrom: 1,
          targetTo: 9,
        }),
      ],
    );
  });

  it("returns 400 when occurrence index is outside the selected text matches", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text appears once.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({ ...validBody, occurrenceIndex: 2 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected text occurrence was not found in the document" });
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("preserves selected text whitespace when validating exact matches", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Old text.",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({ ...validBody, selectedText: "Old text " }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected text must match exactly once in the document" });
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("returns 500 when provider configuration is invalid before a run exists", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockImplementationOnce(() => {
      throw new Error("Unsupported AI_PROVIDER: bad");
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AI generation failed" });
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(failAiRun).not.toHaveBeenCalled();
  });

  it("validates selected text before creating a provider", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      ...documentRecord,
      plainText: "Different document text",
    });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected text must match exactly once in the document" });
    expect(getAiSettings).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 500 and fails the run when finalizing proposals fails", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(completeAiRunWithProposals).mockRejectedValueOnce(new Error("finalize failed"));

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AI generation failed" });
    expect(failAiRun).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "AI generation failed",
    );
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "Improved text",
      [
        expect.objectContaining({
          targetText: "Old text",
          replacementText: "Improved text",
        }),
      ],
    );
  });

  it("marks the AI run failed when generation throws", async () => {
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
      generateText: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      streamText: vi.fn(),
      generateReview: vi.fn(),
    });

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AI generation failed" });
    expect(failAiRun).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      "AI generation failed",
    );
  });
});
