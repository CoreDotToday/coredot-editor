import { describe, expect, it, vi } from "vitest";
import { buildAiMessages } from "./payload-builder";
import { createAiProvider } from "./providers";

const { createOpenAIMock } = vi.hoisted(() => ({
  createOpenAIMock: vi.fn((options: { apiKey?: string; baseURL?: string }) => {
    const provider = vi.fn((model: string) => ({ provider: "openai-compatible", model, options }));
    return provider;
  }),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
  openai: vi.fn((model: string) => ({ provider: "openai", model })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(),
    generateText: vi.fn(),
    streamText: vi.fn(() => ({
      toTextStreamResponse: () => new Response("openai stream"),
    })),
  };
});

describe("AI providers", () => {
  it("uses a deterministic stub provider when AI_PROVIDER is absent", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    delete process.env.AI_PROVIDER;

    try {
      const provider = createAiProvider();
      const messages = buildAiMessages({
        command: "Rewrite for clarity",
        systemPrompt: "You are an editor.",
        variables: { audience: "executives" },
        selectedText: "Margins were bad.",
        beforeContext: "",
        afterContext: "",
        documentText: "",
      });

      await expect(provider.generateText({ messages })).resolves.toBe(
        "Stub rewrite: Margins were bad.\n\n[Command: Rewrite for clarity]",
      );
      await expect((await provider.streamText({ messages })).text()).resolves.toBe(
        "Stub rewrite: Margins were bad.\n\n[Command: Rewrite for clarity]",
      );
      await expect(provider.generateReview({ messages })).resolves.toEqual({
        summary: "Stub review completed.",
        findings: [
          {
            problem: "Stub review finding",
            reason: "Deterministic local provider response.",
            targetText: "Margins were bad.",
            replacementText: "Margins were bad. [reviewed]",
          },
        ],
      });
      expect(provider.name).toBe("stub");
      expect(provider.model).toBe("stub-editor");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }
    }
  });

  it("throws a configuration error for unsupported provider names", () => {
    const originalProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "anthropic";

    try {
      expect(() => createAiProvider()).toThrow("Unsupported AI_PROVIDER: anthropic");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }
    }
  });

  it("exposes OpenAI streaming as a Response", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalModel = process.env.OPENAI_MODEL;
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_MODEL = "gpt-test";

    try {
      const provider = createAiProvider();
      const response = await provider.streamText({ messages: [{ role: "user", content: "Stream this." }] });

      expect(provider.name).toBe("openai");
      expect(provider.model).toBe("gpt-test");
      await expect(response.text()).resolves.toBe("openai stream");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalModel === undefined) {
        delete process.env.OPENAI_MODEL;
      } else {
        process.env.OPENAI_MODEL = originalModel;
      }
    }
  });

  it("uses the Core.Today OpenAI-compatible proxy when AI_PROVIDER is coredot", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalApiKey = process.env.COREDOT_API_KEY;
    const originalModel = process.env.COREDOT_MODEL;
    const originalBaseUrl = process.env.COREDOT_BASE_URL;
    process.env.AI_PROVIDER = "coredot";
    process.env.COREDOT_API_KEY = "test_core_today_key";
    process.env.COREDOT_MODEL = "gpt-5-nano";
    delete process.env.COREDOT_BASE_URL;

    try {
      const provider = createAiProvider();
      const response = await provider.streamText({ messages: [{ role: "user", content: "Stream through proxy." }] });

      expect(provider.name).toBe("coredot");
      expect(provider.model).toBe("gpt-5-nano");
      expect(createOpenAIMock).toHaveBeenCalledWith({
        apiKey: "test_core_today_key",
        baseURL: "https://api.core.today/llm/openai/v1",
      });
      await expect(response.text()).resolves.toBe("openai stream");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }

      if (originalModel === undefined) {
        delete process.env.COREDOT_MODEL;
      } else {
        process.env.COREDOT_MODEL = originalModel;
      }

      if (originalBaseUrl === undefined) {
        delete process.env.COREDOT_BASE_URL;
      } else {
        process.env.COREDOT_BASE_URL = originalBaseUrl;
      }
    }
  });

  it("requires COREDOT_API_KEY for the Core.Today provider", () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalApiKey = process.env.COREDOT_API_KEY;
    process.env.AI_PROVIDER = "coredot";
    delete process.env.COREDOT_API_KEY;

    try {
      expect(() => createAiProvider()).toThrow("COREDOT_API_KEY is required when AI_PROVIDER=coredot");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }
    }
  });
});
