import { createOpenAI, openai } from "@ai-sdk/openai";
import { generateObject, generateText, streamText as streamAiText } from "ai";
import type { AiReasoningEffort } from "./ai-settings-repository";
import { normalizeCoreTodayBaseUrl } from "./core-today-base-url";
import type { AiMessage, ReviewResult } from "./types";
import { reviewResultSchema } from "./types";

export type AiProviderName = "stub" | "openai" | "coredot" | "anthropic" | "gemini";
export type AiProviderSettings = {
  aiBaseUrl?: string | null;
  aiMaxCompletionTokens?: number | null;
  aiModel?: string | null;
  aiProvider?: AiProviderName | null;
  aiReasoningEffort?: AiReasoningEffort | null;
};

export type AiProviderCapabilities = {
  coreTodayProxy: boolean;
  reasoningEffort: boolean;
  streaming: "buffered" | "native";
  structuredReview: boolean;
};

export type AiProvider = {
  capabilities: AiProviderCapabilities;
  name: AiProviderName;
  model: string;
  generateText(input: { messages: AiMessage[]; abortSignal?: AbortSignal }): Promise<string>;
  streamText(input: { messages: AiMessage[]; abortSignal?: AbortSignal }): Promise<Response>;
  generateReview(input: { messages: AiMessage[]; abortSignal?: AbortSignal }): Promise<ReviewResult>;
};

export const AI_PROVIDER_CAPABILITIES: Readonly<Record<AiProviderName, AiProviderCapabilities>> = Object.freeze({
  anthropic: defineAiProviderCapabilities({
    coreTodayProxy: true,
    reasoningEffort: false,
    streaming: "buffered",
    structuredReview: true,
  }),
  coredot: defineAiProviderCapabilities({
    coreTodayProxy: true,
    reasoningEffort: true,
    streaming: "native",
    structuredReview: true,
  }),
  gemini: defineAiProviderCapabilities({
    coreTodayProxy: true,
    reasoningEffort: false,
    streaming: "buffered",
    structuredReview: true,
  }),
  openai: defineAiProviderCapabilities({
    coreTodayProxy: false,
    reasoningEffort: true,
    streaming: "native",
    structuredReview: true,
  }),
  stub: defineAiProviderCapabilities({
    coreTodayProxy: false,
    reasoningEffort: false,
    streaming: "buffered",
    structuredReview: true,
  }),
});

type AiProviderFactory = (settings?: AiProviderSettings) => AiProvider;

const AI_PROVIDER_FACTORIES: Record<AiProviderName, AiProviderFactory> = {
  anthropic: createCoreDotAnthropicProvider,
  coredot: createCoreDotProvider,
  gemini: createCoreDotGeminiProvider,
  openai: createOpenAiProvider,
  stub: createStubAiProvider,
};

export function createAiProvider(settings?: AiProviderSettings): AiProvider {
  const provider = settings?.aiProvider ?? process.env.AI_PROVIDER ?? "stub";
  if (isAiProviderName(provider)) {
    return AI_PROVIDER_FACTORIES[provider](settings);
  }
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}

export function getAiProviderCapabilities(provider: AiProviderName) {
  return AI_PROVIDER_CAPABILITIES[provider];
}

function isAiProviderName(provider: string): provider is AiProviderName {
  return Object.hasOwn(AI_PROVIDER_FACTORIES, provider);
}

function defineAiProviderCapabilities(capabilities: AiProviderCapabilities) {
  return Object.freeze(capabilities);
}

function createOpenAiProvider(settings?: AiProviderSettings): AiProvider {
  const model = settings?.aiModel ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const generationSettings = createGenerationSettings(undefined, settings?.aiReasoningEffort);

  return {
    capabilities: AI_PROVIDER_CAPABILITIES.openai,
    name: "openai",
    model,
    async generateText(input) {
      const result = await generateText({
        abortSignal: input.abortSignal,
        model: openai(model),
        messages: input.messages,
        ...generationSettings,
      });
      return result.text;
    },
    async streamText(input) {
      const result = streamAiText({
        abortSignal: input.abortSignal,
        model: openai(model),
        messages: input.messages,
        ...generationSettings,
      });
      return result.toTextStreamResponse();
    },
    async generateReview(input) {
      const result = await generateObject({
        abortSignal: input.abortSignal,
        model: openai(model),
        messages: input.messages,
        schema: reviewResultSchema,
        ...generationSettings,
      });
      return result.object;
    },
  };
}

function createCoreDotProvider(settings?: AiProviderSettings): AiProvider {
  const baseURL = normalizeCoreTodayBaseUrl("coredot", settings?.aiBaseUrl ?? process.env.COREDOT_BASE_URL);
  const apiKey = requireCoreDotApiKey("coredot");

  const model = settings?.aiModel ?? process.env.COREDOT_MODEL ?? "gpt-5-nano";
  const maxOutputTokens =
    settings?.aiMaxCompletionTokens ?? readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS);
  const generationSettings = createGenerationSettings(maxOutputTokens, settings?.aiReasoningEffort);
  const coreOpenAi = createOpenAI({
    apiKey,
    baseURL,
  });

  return {
    capabilities: AI_PROVIDER_CAPABILITIES.coredot,
    name: "coredot",
    model,
    async generateText(input) {
      const result = await generateText({
        abortSignal: input.abortSignal,
        model: coreOpenAi(model),
        messages: input.messages,
        ...generationSettings,
      });
      return result.text;
    },
    async streamText(input) {
      const result = streamAiText({
        abortSignal: input.abortSignal,
        model: coreOpenAi(model),
        messages: input.messages,
        ...generationSettings,
      });
      return result.toTextStreamResponse();
    },
    async generateReview(input) {
      const result = await generateObject({
        abortSignal: input.abortSignal,
        model: coreOpenAi(model),
        messages: input.messages,
        schema: reviewResultSchema,
        ...generationSettings,
      });
      return result.object;
    },
  };
}

function createCoreDotAnthropicProvider(settings?: AiProviderSettings): AiProvider {
  const baseUrl = normalizeCoreTodayBaseUrl(
    "anthropic",
    settings?.aiBaseUrl ?? process.env.COREDOT_ANTHROPIC_BASE_URL,
  );
  const apiKey = requireCoreDotApiKey("anthropic");
  const model = settings?.aiModel ?? process.env.COREDOT_ANTHROPIC_MODEL ?? "claude-sonnet-4.5";
  const maxOutputTokens =
    settings?.aiMaxCompletionTokens ?? readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ?? 32768;

  return {
    capabilities: AI_PROVIDER_CAPABILITIES.anthropic,
    name: "anthropic",
    model,
    async generateText(input) {
      return postAnthropicMessage({ apiKey, baseUrl, input, maxOutputTokens, model });
    },
    async streamText(input) {
      return new Response(await postAnthropicMessage({ apiKey, baseUrl, input, maxOutputTokens, model }), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
    async generateReview(input) {
      return parseReviewResult(await postAnthropicMessage({ apiKey, baseUrl, input, maxOutputTokens, model }));
    },
  };
}

function createCoreDotGeminiProvider(settings?: AiProviderSettings): AiProvider {
  const baseUrl = normalizeCoreTodayBaseUrl("gemini", settings?.aiBaseUrl ?? process.env.COREDOT_GEMINI_BASE_URL);
  const apiKey = requireCoreDotApiKey("gemini");
  const model = settings?.aiModel ?? process.env.COREDOT_GEMINI_MODEL ?? "gemini-2.5-flash";
  const maxOutputTokens =
    settings?.aiMaxCompletionTokens ?? readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ?? 32768;

  return {
    capabilities: AI_PROVIDER_CAPABILITIES.gemini,
    name: "gemini",
    model,
    async generateText(input) {
      return postGeminiMessage({ apiKey, baseUrl, input, maxOutputTokens, model });
    },
    async streamText(input) {
      return new Response(await postGeminiMessage({ apiKey, baseUrl, input, maxOutputTokens, model }), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
    async generateReview(input) {
      return parseReviewResult(await postGeminiMessage({ apiKey, baseUrl, input, maxOutputTokens, model }));
    },
  };
}

function createGenerationSettings(maxOutputTokens?: number, reasoningEffort?: AiReasoningEffort | null) {
  return {
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(reasoningEffort ? { providerOptions: { openai: { reasoningEffort } } } : {}),
  };
}

function createStubAiProvider(): AiProvider {
  const generateStubText = (input: { messages: AiMessage[] }) => {
    const selectedText = extractSection(input.messages, "Selected text") || extractSection(input.messages, "Document text");
    const command = extractSection(input.messages, "Command") || "Rewrite";
    if (command.toLowerCase().includes("continue writing")) {
      return "Stub continuation: Add the next sentence or paragraph here.";
    }

    return `Stub rewrite: ${selectedText || "No selected text provided."}\n\n[Command: ${command}]`;
  };

  return {
    capabilities: AI_PROVIDER_CAPABILITIES.stub,
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

async function postAnthropicMessage(input: {
  apiKey: string;
  baseUrl: string;
  input: { messages: AiMessage[]; abortSignal?: AbortSignal };
  maxOutputTokens: number;
  model: string;
}) {
  const system = input.input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = input.input.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: "user", content: message.content }));

  const response = await fetch(joinUrl(input.baseUrl, "messages"), {
    signal: input.input.abortSignal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxOutputTokens,
      ...(system ? { system } : {}),
      messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Core.Today Anthropic request failed with status ${response.status}`);
  }

  return parseAnthropicText(await response.json());
}

async function postGeminiMessage(input: {
  apiKey: string;
  baseUrl: string;
  input: { messages: AiMessage[]; abortSignal?: AbortSignal };
  maxOutputTokens: number;
  model: string;
}) {
  const system = input.input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const userText = input.input.messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n\n");

  const response = await fetch(joinUrl(input.baseUrl, `models/${encodeURIComponent(input.model)}:generateContent`), {
    signal: input.input.abortSignal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: input.maxOutputTokens },
    }),
  });

  if (!response.ok) {
    throw new Error(`Core.Today Gemini request failed with status ${response.status}`);
  }

  return parseGeminiText(await response.json());
}

function parseAnthropicText(value: unknown) {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("Invalid Core.Today Anthropic response");
  }

  const text = value.content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");

  if (!text) {
    throw new Error("Core.Today Anthropic response did not include text");
  }

  return text;
}

function parseGeminiText(value: unknown) {
  if (!value || typeof value !== "object" || !("candidates" in value) || !Array.isArray(value.candidates)) {
    throw new Error("Invalid Core.Today Gemini response");
  }

  const text = value.candidates
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || !("content" in candidate)) {
        return [];
      }

      const content = candidate.content;
      if (!content || typeof content !== "object" || !("parts" in content) || !Array.isArray(content.parts)) {
        return [];
      }

      return content.parts.map((part: unknown) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
      );
    })
    .join("");

  if (!text) {
    throw new Error("Core.Today Gemini response did not include text");
  }

  return text;
}

function parseReviewResult(text: string) {
  const parsed = parseJsonFromText(text);
  const result = reviewResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("AI review response did not match the expected schema");
  }

  return result.data;
}

function parseJsonFromText(text: string) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const startIndex = stripped.indexOf("{");
  const endIndex = stripped.lastIndexOf("}");
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error("AI response did not include JSON");
  }

  return JSON.parse(stripped.slice(startIndex, endIndex + 1));
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function requireCoreDotApiKey(provider: AiProviderName) {
  const apiKey = process.env.COREDOT_API_KEY;
  if (!apiKey) {
    throw new Error(`COREDOT_API_KEY is required when AI_PROVIDER=${provider}`);
  }

  return apiKey;
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
