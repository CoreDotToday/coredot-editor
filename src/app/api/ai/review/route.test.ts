import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAiRun,
  completeAiRunWithProposals,
  failAiRun,
  getAiRunByIdempotencyKey,
} from "@/features/ai/ai-run-repository";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById } from "@/features/documents/document-repository";
import { getAiReferenceProjectionsByIds } from "@/features/ai/reference-projection-repository";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { createAiOperationFingerprint } from "@/features/ai/ai-execution";
import { AiRunCollaborationFenceError } from "@/features/ai/ai-collaboration-fence";
import { aiCommandPayloadSchema } from "@/features/ai/types";
import { POST } from "./route";
import {
  aiCollaborationCodec as collaborationCodec,
  loadAiCollaborationSnapshot,
} from "@/features/ai/ai-collaboration-snapshot";
import * as Y from "yjs";

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentById: vi.fn(),
}));

vi.mock("@/features/ai/reference-projection-repository", () => ({
  getAiReferenceProjectionsByIds: vi.fn(async () => []),
}));

vi.mock("@/features/ai/ai-collaboration-snapshot", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/ai/ai-collaboration-snapshot")>(),
  loadAiCollaborationSnapshot: vi.fn(async () => null),
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
      commandType: "document_review",
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
  failAiRun: vi.fn(),
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
  workspaceId: "vitest-workspace",
  creationKey: null,
  title: "Memo",
  plainText: "growth was good and someone should follow up",
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

function createJsonRequest(body: unknown, idempotencyKey?: string) {
  return new Request("http://localhost/api/ai/review", {
    method: "POST",
    headers: idempotencyKey === undefined ? undefined : { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

function createCollaborativeSnapshot(text: string) {
  const document = collaborationCodec.bootstrap({
    contentJson: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    metadataJson: { owner: "Exact owner" },
    plainText: text,
    title: "Exact title",
  });
  const checkpoint = collaborationCodec.encodeCheckpoint(document);
  const stateVector = Y.encodeStateVector(document);
  document.destroy();
  return {
    barrier: { generation: 2, stateVector: Buffer.from(stateVector).toString("base64url") },
    snapshot: {
      checkpointSeq: 0,
      document: collaborationCodec.loadCheckpoint(checkpoint),
      documentId: "doc_1",
      generation: 2,
      headSeq: 9,
      projectedSeq: 5,
      schemaFingerprint: collaborationCodec.fingerprint(),
      schemaVersion: 1,
    },
  };
}

describe("POST /api/ai/review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the Idempotency-Key after the body and before budget or provider work", async () => {
    const consume = vi.fn(async () => ({
      allowed: true,
      limit: 20,
      remaining: 19,
      retryAt: new Date(Date.now() + 60_000),
    }));
    setRequestBudgetForTests({ consume });
    const response = await POST(createJsonRequest({
      command: "Review",
      documentId: "doc_1",
      templateId: "tpl_1",
      variables: {},
    }, "contains spaces"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Idempotency-Key header" });
    expect(consume).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
  });

  it("replays exact durable review output for an explicit matching key", async () => {
    const replayBody = {
      command: "Review",
      documentId: "doc_1",
      templateId: "tpl_1",
      variables: {},
    };
    const normalized = aiCommandPayloadSchema.parse(replayBody);
    const operationFingerprint = await createAiOperationFingerprint("review", {
      ...normalized,
      documentTextSource: "persisted",
    });
    const durableReview = {
      findings: [{
        problem: "Durable problem",
        reason: "Durable reason",
        replacementText: "Durable replacement",
        targetText: "growth was good",
      }],
      summary: "Durable summary",
    };
    vi.mocked(getAiRunByIdempotencyKey).mockResolvedValueOnce({
      proposals: [{
        command: null,
        defaultApplyMode: "replace",
        explanation: "Durable problem: Durable reason",
        id: "durable_proposal",
        occurrenceIndex: 0,
        replacementText: "Durable replacement",
        source: "review",
        status: "pending",
        targetFrom: null,
        targetText: "growth was good",
        targetTo: null,
      }],
      run: {
        commandType: "document_review",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        id: "durable_run",
        idempotencyKey: "review-key",
        operationFingerprint,
        outputText: JSON.stringify(durableReview),
        status: "completed",
        workspaceId: "must-not-leak",
        inputSummaryJson: { prompt: "must-not-leak" },
      },
    } as never);

    const response = await POST(createJsonRequest(replayBody, "review-key"));

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      proposals: [{ id: "durable_proposal", replacementText: "Durable replacement" }],
      review: { summary: "Durable summary" },
      run: { id: "durable_run" },
      skippedProposalCount: 0,
    });
    expect(Object.keys(responseBody.run).sort()).toEqual(["commandType", "createdAt", "id", "status"]);
    expect(JSON.stringify(responseBody)).not.toMatch(/must-not-leak|review-key|operationFingerprint|idempotencyKey|workspaceId|inputSummaryJson/);
    expect(claimAiRun).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
  });

  it("replays the fixed collaborative run after head advance but conflicts on a changed browser barrier", async () => {
    const body = {
      collaborationBarrier: { generation: 2, stateVector: "AA" },
      command: "Review",
      documentId: "doc_1",
      templateId: "tpl_1",
      variables: {},
    };
    const operationFingerprint = await createAiOperationFingerprint("review", {
      ...aiCommandPayloadSchema.parse(body),
      documentTextSource: "persisted",
    });
    const durable = {
      collaborationSnapshot: {
        contentHash: "b".repeat(64),
        documentId: "doc_1",
        generation: 2,
        headSeq: 9,
        schemaFingerprint: "a".repeat(64),
        stateVector: Buffer.from([0]),
      },
      proposalAnchors: [],
      proposals: [],
      run: {
        commandType: "document_review" as const,
        id: "fixed-run",
        operationFingerprint,
        outputText: JSON.stringify({ findings: [], summary: "Fixed result" }),
        status: "completed",
      },
    };
    vi.mocked(getAiRunByIdempotencyKey).mockResolvedValueOnce(durable as never);
    const replay = await POST(createJsonRequest(body, "fixed-key"));

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ review: { summary: "Fixed result" } });
    expect(loadAiCollaborationSnapshot).not.toHaveBeenCalled();

    vi.mocked(getAiRunByIdempotencyKey).mockResolvedValueOnce(durable as never);
    const conflict = await POST(createJsonRequest({
      ...body,
      collaborationBarrier: { generation: 3, stateVector: "AA" },
    }, "fixed-key"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_key_reused" });
    expect(loadAiCollaborationSnapshot).not.toHaveBeenCalled();
  });

  it("generates a server UUID for a missing compatibility header on a fresh operation", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);

    const response = await POST(createJsonRequest({
      command: "Review",
      documentId: "doc_1",
      templateId: "tpl_1",
      variables: {},
    }));

    expect(response.status).toBe(200);
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      }),
    );
  });

  it("preserves 429 headers without reading the request body when the budget is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
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
      expect(response.headers.get("Retry-After")).toBe("5");
      expect(read).not.toHaveBeenCalled();
      expect(createAiProvider).not.toHaveBeenCalled();
      expect(claimAiRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects an oversized chunked AI body despite a falsely small Content-Length", async () => {
    const cancel = vi.fn();
    const request = {
      body: {
        getReader: () => ({
          cancel,
          read: vi.fn().mockResolvedValueOnce({
            done: false,
            value: new Uint8Array(RESOURCE_LIMITS.documentJsonBytes + 1024 * 1024 + 1),
          }),
          releaseLock: vi.fn(),
        }),
      },
      headers: new Headers({ "content-length": "1" }),
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("bounds a stalled request body stream with the remaining admission deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const read = vi.fn(async () => new Promise(() => undefined));
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: true,
        limit: 20,
        remaining: 19,
        retryAt: new Date(Date.now() + 60_000),
      })),
    });
    let response: Response | undefined;

    try {
      void POST({
        body: { getReader: () => ({ cancel, read, releaseLock }) },
        headers: new Headers({ "content-length": "128", "Idempotency-Key": "stalled-body-key" }),
      } as unknown as Request).then((value) => {
        response = value;
      });
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);

      expect(response?.status).toBe(504);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      expect(getDocumentById).not.toHaveBeenCalled();
      expect(createAiProvider).not.toHaveBeenCalled();
      expect(claimAiRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 408 and cancels a stalled body stream when the request is aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const read = vi.fn(async () => new Promise(() => undefined));
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: true,
        limit: 20,
        remaining: 19,
        retryAt: new Date(Date.now() + 60_000),
      })),
    });
    const pending = POST({
      body: { getReader: () => ({ cancel, read, releaseLock }) },
      headers: new Headers({ "content-length": "128", "Idempotency-Key": "aborted-body-key" }),
      signal: controller.signal,
    } as unknown as Request);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    controller.abort();
    const response = await pending;

    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 504, aborts the provider, and does not persist proposals after timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generateReview = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      markStarted?.();
      return new Promise<never>((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
      });
    });
    vi.mocked(createAiProvider).mockReturnValueOnce({
      capabilities: { coreTodayProxy: false, reasoningEffort: false, streaming: "buffered", structuredReview: true },
      generateReview,
      generateText: vi.fn(),
      model: "stub-editor",
      name: "stub",
      streamText: vi.fn(),
    });

    try {
      const pending = POST(createJsonRequest({ documentId: "doc_1", templateId: "tpl_1", command: "Review", variables: {} }));
      await started;
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(generateReview.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
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
    expect(claimAiRun).not.toHaveBeenCalled();
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
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      run: { id: "run_1", status: "completed" },
      review: { summary: "Two findings." },
      proposals: [{ targetText: "growth was good" }, { targetText: "someone should follow up" }],
      skippedProposalCount: 1,
    });
    expect(Object.keys(responseBody.run).sort()).toEqual(["commandType", "createdAt", "id", "status"]);
    expect(JSON.stringify(responseBody)).not.toMatch(/must-not-leak|operationFingerprint|idempotencyKey|workspaceId|inputSummaryJson/);
    expect(claimAiRun).toHaveBeenCalledWith(
      localWorkspace,
      expect.objectContaining({ commandType: "document_review" }),
    );
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      expect.stringContaining("Two findings."),
      expect.arrayContaining([
        expect.objectContaining({ occurrenceIndex: 0, targetText: "growth was good" }),
        expect.objectContaining({ occurrenceIndex: 0, targetText: "someone should follow up" }),
      ]),
    );
  });

  it("uses exact collaborative text and fixes run identity plus proposal anchors", async () => {
    const collaborative = createCollaborativeSnapshot(
      "growth was good and someone should follow up",
    );
    const generateReview = vi.fn(async () => ({
      findings: [{
        problem: "Unclear",
        reason: "Be exact",
        replacementText: "revenue grew 8%",
        targetText: "growth was good",
      }],
      summary: "Exact review",
    }));
    vi.mocked(loadAiCollaborationSnapshot).mockResolvedValueOnce(collaborative.snapshot);
    vi.mocked(getDocumentById).mockResolvedValueOnce({ ...documentRecord, plainText: "Stale SQL" });
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(createAiProvider).mockReturnValueOnce({
      capabilities: { coreTodayProxy: false, reasoningEffort: false, streaming: "buffered", structuredReview: true },
      generateReview,
      generateText: vi.fn(),
      model: "stub-editor",
      name: "stub",
      streamText: vi.fn(),
    });

    const response = await POST(createJsonRequest({
      collaborationBarrier: collaborative.barrier,
      command: "Review",
      documentId: "doc_1",
      documentText: "Untrusted browser draft",
      templateId: "tpl_1",
      variables: {},
    }, "collaboration-review"));

    expect(response.status).toBe(200);
    expect(generateReview).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining("growth was good and someone should follow up"),
      })]),
    }));
    expect(JSON.stringify(generateReview.mock.calls)).not.toMatch(/Stale SQL|Untrusted browser draft/u);
    expect(claimAiRun).toHaveBeenCalledWith(localWorkspace, expect.objectContaining({
      collaborationSnapshot: expect.objectContaining({
        documentId: "doc_1",
        generation: 2,
        headSeq: 9,
        schemaFingerprint: collaborationCodec.fingerprint(),
        stateVector: expect.any(Uint8Array),
      }),
    }));
    expect(completeAiRunWithProposals).toHaveBeenCalledWith(
      localWorkspace,
      "run_1",
      "attempt-token-1",
      expect.any(String),
      [expect.objectContaining({
        anchor: expect.objectContaining({
          baseHeadSeq: 9,
          endAssoc: 1,
          generation: 2,
          startAssoc: -1,
        }),
        targetText: "growth was good",
      })],
    );
  });

  it("rejects missing or mismatched collaboration barriers before provider and claim", async () => {
    for (const collaborationBarrier of [undefined, { generation: 1, stateVector: "AA" }]) {
      const collaborative = createCollaborativeSnapshot("growth was good");
      vi.mocked(loadAiCollaborationSnapshot).mockResolvedValueOnce(collaborative.snapshot);
      vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
      vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
      const response = await POST(createJsonRequest({
        ...(collaborationBarrier ? { collaborationBarrier } : {}),
        command: "Review",
        documentId: "doc_1",
        templateId: "tpl_1",
        variables: {},
      }, crypto.randomUUID()));
      expect(response.status).toBe(409);
    }
    expect(createAiProvider).not.toHaveBeenCalled();
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("hydrates referenced documents by id before building the review prompt", async () => {
    const generateReview = vi.fn(async () => ({ summary: "No findings.", findings: [] }));
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getAiReferenceProjectionsByIds).mockResolvedValueOnce([
      {
        ...documentRecord,
        generation: null,
        headSeq: null,
        id: "doc_ref",
        projectedSeq: null,
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
    expect(getAiReferenceProjectionsByIds).toHaveBeenCalledWith(localWorkspace, ["doc_ref"]);
    expect(generateReview).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    }));
    expect(generateReview).toHaveBeenCalledWith(expect.objectContaining({
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

  it("excludes the current document from referenced review context", async () => {
    const generateReview = vi.fn(async () => ({ summary: "No findings.", findings: [] }));
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getAiReferenceProjectionsByIds).mockResolvedValueOnce([
      {
        ...documentRecord,
        generation: null,
        headSeq: null,
        id: "doc_ref",
        projectedSeq: null,
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
    expect(getAiReferenceProjectionsByIds).toHaveBeenCalledWith(localWorkspace, ["doc_ref"]);
    expect(generateReview).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Reference memo body"),
        }),
      ]),
    }));
    expect(generateReview).toHaveBeenCalledWith(expect.objectContaining({
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
      "attempt-token-1",
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
    expect(claimAiRun).toHaveBeenCalledWith(
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
      "attempt-token-1",
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
    expect(claimAiRun).not.toHaveBeenCalled();
  });

  it("returns a stable 409 when collaboration initializes between legacy preflight and claim", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(documentRecord);
    vi.mocked(getPromptTemplateById).mockResolvedValueOnce(templateRecord);
    vi.mocked(claimAiRun).mockRejectedValueOnce(new AiRunCollaborationFenceError());

    const response = await POST(createJsonRequest({
      command: "Review",
      documentId: "doc_1",
      templateId: "tpl_1",
      variables: {},
    }, "legacy-initialize-race"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "collaboration_snapshot_conflict",
      error: "Collaboration snapshot is not available for this request",
    });
    expect(completeAiRunWithProposals).not.toHaveBeenCalled();
    expect(failAiRun).not.toHaveBeenCalled();
  });
});
