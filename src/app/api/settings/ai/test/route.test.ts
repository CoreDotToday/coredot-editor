import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { OPTIONS, POST } from "./route";

vi.mock("@/features/ai/ai-settings-repository", () => ({
  getAiSettings: vi.fn(async () => ({
    aiBaseUrl: "https://api.core.today/llm/openai/v1",
    aiMaxCompletionTokens: 32768,
    aiModel: "gpt-5-nano",
    aiProvider: "coredot",
    aiReasoningEffort: null,
    id: "default",
  })),
}));

vi.mock("@/features/ai/providers", () => ({
  createAiProvider: vi.fn(() => ({
    capabilities: {
      coreTodayProxy: true,
      reasoningEffort: true,
      streaming: "native",
      structuredReview: true,
    },
    generateText: vi.fn(async () => "OK"),
    model: "gpt-5-nano",
    name: "coredot",
  })),
}));

function createAllowedBudgetConsume() {
  return vi.fn(async () => ({
    allowed: true,
    limit: 5,
    remaining: 4,
    retryAt: new Date(Date.now() + 60_000),
  }));
}

function createWorkspaceBootstrap() {
  return vi.fn(async () => undefined);
}

describe("POST /api/settings/ai/test", () => {
  let consume: ReturnType<typeof createAllowedBudgetConsume>;
  let ensureWorkspaceBootstrap: ReturnType<typeof createWorkspaceBootstrap>;

  beforeEach(() => {
    vi.clearAllMocks();
    consume = createAllowedBudgetConsume();
    ensureWorkspaceBootstrap = createWorkspaceBootstrap();
    setRequestBudgetForTests({ consume });
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("tests the saved provider settings without requiring browser-side secrets", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: "gpt-5-nano",
      ok: true,
      provider: "coredot",
    });
    expect(getAiSettings).toHaveBeenCalled();
    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
      }),
    );
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({
      context: TEST_REQUEST_CONTEXT,
      policyId: "ai.connection-test",
    }));
  });

  it("returns 429 before workspace bootstrap or provider settings access when the budget is exhausted", async () => {
    consume.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAt: new Date(Date.now() + 5_000),
    });

    const response = await POST();

    expect(response.status).toBe(429);
    expect(ensureWorkspaceBootstrap).not.toHaveBeenCalled();
    expect(getAiSettings).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
  });

  it("returns 400 when the provider cannot be configured", async () => {
    vi.mocked(createAiProvider).mockImplementationOnce(() => {
      throw new Error("COREDOT_API_KEY is required when AI_PROVIDER=coredot");
    });

    const response = await POST();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "LLM 설정을 확인해 주세요.", ok: false });
  });

  it("forbids members from exercising saved provider credentials", async () => {
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap,
      getRequestContext: async () => ({ ...TEST_REQUEST_CONTEXT, role: "member" }),
    });

    const response = await POST();

    expect(response.status).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect(ensureWorkspaceBootstrap).not.toHaveBeenCalled();
    expect(getAiSettings).not.toHaveBeenCalled();
    expect(createAiProvider).not.toHaveBeenCalled();
  });

  it("returns 504 and aborts the provider connection test at the operation deadline", async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generateText = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      markStarted?.();
      if (!abortSignal) return Promise.reject(new Error("AbortSignal is required"));
      return new Promise<string>((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason));
      });
    });
    vi.mocked(createAiProvider).mockReturnValueOnce({
      capabilities: {
        coreTodayProxy: true,
        reasoningEffort: true,
        streaming: "native",
        structuredReview: true,
      },
      generateReview: vi.fn(),
      generateText,
      model: "gpt-5-nano",
      name: "coredot",
      streamText: vi.fn(),
    });

    try {
      const pending = POST();
      await started;
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "Operation timed out" });
      expect(generateText.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not consume the provider connection-test budget for OPTIONS", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(consume).not.toHaveBeenCalled();
  });
});
