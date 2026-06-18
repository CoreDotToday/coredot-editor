import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import { POST } from "./route";

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

describe("POST /api/settings/ai/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it("returns 400 when the provider cannot be configured", async () => {
    vi.mocked(createAiProvider).mockImplementationOnce(() => {
      throw new Error("COREDOT_API_KEY is required when AI_PROVIDER=coredot");
    });

    const response = await POST();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "LLM 설정을 확인해 주세요.", ok: false });
  });
});
