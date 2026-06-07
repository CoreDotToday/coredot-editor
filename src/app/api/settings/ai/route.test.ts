import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiSettings, updateAiSettings } from "@/features/ai/ai-settings-repository";
import { GET, PUT } from "./route";

vi.mock("@/features/ai/ai-settings-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/ai/ai-settings-repository")>();
  return {
    ...actual,
    getAiSettings: vi.fn(async () => ({
      aiBaseUrl: "https://api.core.today/llm/openai/v1",
      aiMaxCompletionTokens: 32768,
      aiModel: "gpt-5-nano",
      aiProvider: "coredot",
      aiReasoningEffort: null,
      id: "default",
    })),
    updateAiSettings: vi.fn(async (input) => ({
      ...input,
      id: "default",
    })),
  };
});

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("/api/settings/ai", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns settings with secret configuration booleans only", async () => {
    const originalCoreDotKey = process.env.COREDOT_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.COREDOT_API_KEY = "secret_core_key";
    delete process.env.OPENAI_API_KEY;

    try {
      const response = await GET();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        settings: {
          aiBaseUrl: "https://api.core.today/llm/openai/v1",
          aiMaxCompletionTokens: 32768,
          aiModel: "gpt-5-nano",
          aiProvider: "coredot",
          aiReasoningEffort: null,
          id: "default",
        },
        secrets: {
          coredotConfigured: true,
          openaiConfigured: false,
        },
      });
    } finally {
      if (originalCoreDotKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalCoreDotKey;
      }

      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("updates only non-secret model settings", async () => {
    const response = await PUT(
      createJsonRequest({
        aiBaseUrl: "https://api.core.today/llm/openai/v1",
        aiMaxCompletionTokens: 64000,
        aiModel: "gpt-5-mini",
        aiProvider: "coredot",
        aiReasoningEffort: "medium",
        apiKey: "browser-secret-should-not-pass",
      }),
    );

    expect(response.status).toBe(200);
    expect(updateAiSettings).toHaveBeenCalledWith({
      aiBaseUrl: "https://api.core.today/llm/openai/v1",
      aiMaxCompletionTokens: 64000,
      aiModel: "gpt-5-mini",
      aiProvider: "coredot",
      aiReasoningEffort: "medium",
    });
    expect(JSON.stringify(await response.json())).not.toContain("browser-secret");
  });

  it("returns 400 for invalid settings payloads", async () => {
    const response = await PUT(
      createJsonRequest({
        aiBaseUrl: "not-a-url",
        aiModel: "",
        aiProvider: "coredot",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(getAiSettings).not.toHaveBeenCalled();
  });
});
