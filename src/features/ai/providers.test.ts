import { describe, expect, it, vi } from "vitest";
import { buildAiMessages } from "./payload-builder";
import { createAiProvider } from "./providers";

vi.mock("@ai-sdk/openai", () => ({
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
});
