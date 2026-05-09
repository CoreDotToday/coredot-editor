import { createOpenAI, openai } from "@ai-sdk/openai";
import { generateObject, generateText, streamText as streamAiText } from "ai";
import type { AiMessage, ReviewResult } from "./types";
import { reviewResultSchema } from "./types";

export type AiProviderName = "stub" | "openai" | "coredot";

export type AiProvider = {
  name: AiProviderName;
  model: string;
  generateText(input: { messages: AiMessage[] }): Promise<string>;
  streamText(input: { messages: AiMessage[] }): Promise<Response>;
  generateReview(input: { messages: AiMessage[] }): Promise<ReviewResult>;
};

export function createAiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER ?? "stub";

  if (provider === "stub") {
    return createStubAiProvider();
  }

  if (provider === "openai") {
    return createOpenAiProvider();
  }

  if (provider === "coredot") {
    return createCoreDotProvider();
  }

  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
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
    async streamText(input) {
      const result = streamAiText({
        model: openai(model),
        messages: input.messages,
      });
      return result.toTextStreamResponse();
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

function createCoreDotProvider(): AiProvider {
  const apiKey = process.env.COREDOT_API_KEY;
  if (!apiKey) {
    throw new Error("COREDOT_API_KEY is required when AI_PROVIDER=coredot");
  }

  const model = process.env.COREDOT_MODEL ?? "gpt-5-nano";
  const maxOutputTokens = readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS);
  const coreOpenAi = createOpenAI({
    apiKey,
    baseURL: process.env.COREDOT_BASE_URL ?? "https://api.core.today/llm/openai/v1",
  });

  return {
    name: "coredot",
    model,
    async generateText(input) {
      const result = await generateText({
        model: coreOpenAi(model),
        messages: input.messages,
        maxOutputTokens,
      });
      return result.text;
    },
    async streamText(input) {
      const result = streamAiText({
        model: coreOpenAi(model),
        messages: input.messages,
        maxOutputTokens,
      });
      return result.toTextStreamResponse();
    },
    async generateReview(input) {
      const result = await generateObject({
        model: coreOpenAi(model),
        messages: input.messages,
        schema: reviewResultSchema,
        maxOutputTokens,
      });
      return result.object;
    },
  };
}

function createStubAiProvider(): AiProvider {
  const generateStubText = (input: { messages: AiMessage[] }) => {
    const selectedText = extractSection(input.messages, "Selected text") || extractSection(input.messages, "Document text");
    const command = extractSection(input.messages, "Command") || "Rewrite";
    return `Stub rewrite: ${selectedText || "No selected text provided."}\n\n[Command: ${command}]`;
  };

  return {
    name: "stub",
    model: "stub-editor",
    async generateText(input) {
      return generateStubText(input);
    },
    async streamText(input) {
      return new Response(generateStubText(input), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
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

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
