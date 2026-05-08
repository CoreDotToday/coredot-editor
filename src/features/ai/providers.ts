import { openai } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import type { AiMessage, ReviewResult } from "./types";
import { reviewResultSchema } from "./types";

export type AiProviderName = "stub" | "openai";

export type AiProvider = {
  name: AiProviderName;
  model: string;
  generateText(input: { messages: AiMessage[] }): Promise<string>;
  generateReview(input: { messages: AiMessage[] }): Promise<ReviewResult>;
};

export function createAiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER ?? "stub";

  if (provider === "openai") {
    return createOpenAiProvider();
  }

  return createStubAiProvider();
}

function createOpenAiProvider(): AiProvider {
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  return {
    name: "openai",
    model,
    async generateText(input) {
      const result = await generateText({
        model: openai(model),
        messages: input.messages,
      });
      return result.text;
    },
    async generateReview(input) {
      const result = await generateObject({
        model: openai(model),
        messages: input.messages,
        schema: reviewResultSchema,
      });
      return result.object;
    },
  };
}

function createStubAiProvider(): AiProvider {
  return {
    name: "stub",
    model: "stub-editor",
    async generateText(input) {
      const selectedText = extractSection(input.messages, "Selected text") || extractSection(input.messages, "Document text");
      const command = extractSection(input.messages, "Command") || "Rewrite";
      return `Stub rewrite: ${selectedText || "No selected text provided."}\n\n[Command: ${command}]`;
    },
    async generateReview(input) {
      const targetText = extractSection(input.messages, "Selected text") || extractSection(input.messages, "Document text");
      const normalizedTarget = targetText || "No document text provided.";

      return {
        summary: "Stub review completed.",
        findings: [
          {
            problem: "Stub review finding",
            reason: "Deterministic local provider response.",
            targetText: normalizedTarget,
            replacementText: `${normalizedTarget} [reviewed]`,
          },
        ],
      };
    },
  };
}

function extractSection(messages: AiMessage[], section: string): string {
  const userMessage = messages.find((message) => message.role === "user")?.content ?? "";
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = userMessage.match(new RegExp(`${escapedSection}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^:\\n]*:\\n|$)`));
  return match?.[1]?.trim() ?? "";
}
