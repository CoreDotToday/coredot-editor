import { describe, expect, it } from "vitest";
import { buildAiMessages } from "./payload-builder";
import { createAiProvider } from "./providers";

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
});
