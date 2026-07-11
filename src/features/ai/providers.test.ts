import { describe, expect, it, vi } from "vitest";
import { buildAiMessages } from "./payload-builder";
import { createAiProvider, getAiProviderCapabilities } from "./providers";

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
    generateText: vi.fn(async () => ({ text: "openai text" })),
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
      expect(provider.capabilities).toEqual({
        coreTodayProxy: false,
        reasoningEffort: false,
        streaming: "buffered",
        structuredReview: true,
      });
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }
    }
  });

  it("exposes provider capability metadata for runtime feature gating", () => {
    const originalApiKey = process.env.COREDOT_API_KEY;
    process.env.COREDOT_API_KEY = "test_core_today_key";

    try {
      expect(createAiProvider({ aiProvider: "stub" }).capabilities).toMatchObject({
        coreTodayProxy: false,
        reasoningEffort: false,
        streaming: "buffered",
      });
      expect(createAiProvider({ aiProvider: "openai" }).capabilities).toMatchObject({
        coreTodayProxy: false,
        reasoningEffort: true,
        streaming: "native",
      });
      expect(createAiProvider({ aiProvider: "coredot" }).capabilities).toMatchObject({
        coreTodayProxy: true,
        reasoningEffort: true,
        streaming: "native",
      });
      expect(createAiProvider({ aiProvider: "anthropic" }).capabilities).toMatchObject({
        coreTodayProxy: true,
        reasoningEffort: false,
        streaming: "buffered",
      });
      expect(createAiProvider({ aiProvider: "gemini" }).capabilities).toMatchObject({
        coreTodayProxy: true,
        reasoningEffort: false,
        streaming: "buffered",
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }
    }
  });

  it("exposes side-effect-free capability lookup without provider credentials", () => {
    const originalApiKey = process.env.COREDOT_API_KEY;
    delete process.env.COREDOT_API_KEY;

    try {
      expect(getAiProviderCapabilities("coredot")).toEqual({
        coreTodayProxy: true,
        reasoningEffort: true,
        streaming: "native",
        structuredReview: true,
      });
      expect(getAiProviderCapabilities("anthropic")).toMatchObject({
        coreTodayProxy: true,
        streaming: "buffered",
      });
      expect(Object.isFrozen(getAiProviderCapabilities("coredot"))).toBe(true);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }
    }
  });

  it("returns continuation-only stub text for continue writing commands", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    delete process.env.AI_PROVIDER;

    try {
      const provider = createAiProvider();
      const messages = buildAiMessages({
        command: "Continue writing",
        systemPrompt: "You are an editor.",
        variables: {},
        selectedText: "The renewal risk is material.",
        beforeContext: "",
        afterContext: "",
        documentText: "The renewal risk is material.",
      });

      await expect(provider.generateText({ messages })).resolves.toBe(
        "Stub continuation: Add the next sentence or paragraph here.",
      );
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
    process.env.AI_PROVIDER = "bad-provider";

    try {
      expect(() => createAiProvider()).toThrow("Unsupported AI_PROVIDER: bad-provider");
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

  it("uses saved Core.Today model settings over environment defaults", async () => {
    const { generateText } = await import("ai");
    const originalProvider = process.env.AI_PROVIDER;
    const originalApiKey = process.env.COREDOT_API_KEY;
    const originalModel = process.env.COREDOT_MODEL;
    const originalBaseUrl = process.env.COREDOT_BASE_URL;
    const originalMaxCompletionTokens = process.env.COREDOT_MAX_COMPLETION_TOKENS;
    process.env.AI_PROVIDER = "stub";
    process.env.COREDOT_API_KEY = "test_core_today_key";
    process.env.COREDOT_MODEL = "gpt-env-model";
      process.env.COREDOT_BASE_URL = "https://api.core.today/llm/openai/v1";
    process.env.COREDOT_MAX_COMPLETION_TOKENS = "123";
    createOpenAIMock.mockClear();
    vi.mocked(generateText).mockClear();

    try {
      const provider = createAiProvider({
        aiBaseUrl: "https://api.core.today/llm/openai/v1/",
        aiMaxCompletionTokens: 64000,
        aiModel: "gpt-5.4-mini",
        aiProvider: "coredot",
        aiReasoningEffort: "medium",
      });
      const controller = new AbortController();
      const text = await provider.generateText({
        abortSignal: controller.signal,
        messages: [{ role: "user", content: "Configured generation." }],
      });

      expect(text).toBe("openai text");
      expect(provider.name).toBe("coredot");
      expect(provider.model).toBe("gpt-5.4-mini");
      expect(createOpenAIMock).toHaveBeenCalledWith({
        apiKey: "test_core_today_key",
        baseURL: "https://api.core.today/llm/openai/v1",
      });
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          abortSignal: controller.signal,
          maxOutputTokens: 64000,
          providerOptions: { openai: { reasoningEffort: "medium" } },
        }),
      );
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

      if (originalMaxCompletionTokens === undefined) {
        delete process.env.COREDOT_MAX_COMPLETION_TOKENS;
      } else {
        process.env.COREDOT_MAX_COMPLETION_TOKENS = originalMaxCompletionTokens;
      }
    }
  });

  it("forwards AbortSignal to structured AI SDK review generation", async () => {
    const { generateObject } = await import("ai");
    const controller = new AbortController();
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { findings: [], summary: "No findings." },
    } as Awaited<ReturnType<typeof generateObject>>);
    const provider = createAiProvider({ aiProvider: "openai", aiModel: "gpt-test" });

    await provider.generateReview({
      abortSignal: controller.signal,
      messages: [{ role: "user", content: "Review." }],
    });

    expect(generateObject).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: controller.signal }));
  });

  it("calls the Core.Today Anthropic proxy when the saved provider is anthropic", async () => {
    const originalApiKey = process.env.COREDOT_API_KEY;
    process.env.COREDOT_API_KEY = "test_core_today_key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "anthropic text" }],
        }),
      ),
    );

    try {
      const provider = createAiProvider({
        aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
        aiMaxCompletionTokens: 8192,
        aiModel: "claude-sonnet-4.5",
        aiProvider: "anthropic",
        aiReasoningEffort: null,
      });
      const controller = new AbortController();
      const text = await provider.generateText({
        abortSignal: controller.signal,
        messages: [{ role: "user", content: "Use Anthropic." }],
      });

      expect(provider.name).toBe("anthropic");
      expect(provider.model).toBe("claude-sonnet-4.5");
      expect(text).toBe("anthropic text");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.core.today/llm/anthropic/v1/messages",
        expect.objectContaining({
          body: expect.stringContaining('"max_tokens":8192'),
          method: "POST",
          signal: controller.signal,
        }),
      );
    } finally {
      fetchMock.mockRestore();
      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }
    }
  });

  it("calls the Core.Today Gemini proxy when the saved provider is gemini", async () => {
    const originalApiKey = process.env.COREDOT_API_KEY;
    process.env.COREDOT_API_KEY = "test_core_today_key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "gemini text" }] } }],
        }),
      ),
    );

    try {
      const provider = createAiProvider({
        aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
        aiMaxCompletionTokens: 4096,
        aiModel: "gemini-2.5-flash",
        aiProvider: "gemini",
        aiReasoningEffort: null,
      });
      const controller = new AbortController();
      const text = await provider.generateText({
        abortSignal: controller.signal,
        messages: [{ role: "user", content: "Use Gemini." }],
      });

      expect(provider.name).toBe("gemini");
      expect(provider.model).toBe("gemini-2.5-flash");
      expect(text).toBe("gemini text");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.core.today/llm/gemini/v1beta/models/gemini-2.5-flash:generateContent",
        expect.objectContaining({
          body: expect.stringContaining('"maxOutputTokens":4096'),
          method: "POST",
          signal: controller.signal,
        }),
      );
    } finally {
      fetchMock.mockRestore();
      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
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

  it("rejects non-Core.Today proxy URLs before using the Core.Today API key", () => {
    const originalApiKey = process.env.COREDOT_API_KEY;
    delete process.env.COREDOT_API_KEY;
    createOpenAIMock.mockClear();

    try {
      expect(() =>
        createAiProvider({
          aiBaseUrl: "https://attacker.example.test/llm/openai/v1",
          aiMaxCompletionTokens: 32768,
          aiModel: "gpt-5-nano",
          aiProvider: "coredot",
          aiReasoningEffort: null,
        }),
      ).toThrow("Invalid Core.Today base URL");
      expect(createOpenAIMock).not.toHaveBeenCalled();

      expect(() =>
        createAiProvider({
          aiBaseUrl: "https://api.core.today/llm/openai/v1",
          aiMaxCompletionTokens: 8192,
          aiModel: "claude-sonnet-4.5",
          aiProvider: "anthropic",
          aiReasoningEffort: null,
        }),
      ).toThrow("Invalid Core.Today base URL");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalApiKey;
      }
    }
  });
});
