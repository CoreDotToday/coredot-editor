import { describe, expect, it } from "vitest";
import { buildAiMessages } from "./payload-builder";

describe("buildAiMessages", () => {
  it("combines system prompt, variables, selection, and context", () => {
    const messages = buildAiMessages({
      systemPrompt: "You are a strategy editor.",
      command: "Improve clarity",
      variables: { audience: "CEO", tone: "executive" },
      selectedText: "We might enter Japan.",
      beforeContext: "International expansion options:",
      afterContext: "Risks include distribution gaps.",
      documentText: "International expansion options:\nWe might enter Japan.\nRisks include distribution gaps.",
    });

    expect(messages[0]).toEqual({ role: "system", content: "You are a strategy editor." });
    expect(messages[1]?.content).toContain("audience: CEO");
    expect(messages[1]?.content).toContain("Selected text:\nWe might enter Japan.");
  });
});
