import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { appSettings, type AppSettingsRecord } from "@/db/schema";
import {
  DEFAULT_COREDOT_ANTHROPIC_BASE_URL,
  DEFAULT_COREDOT_BASE_URL,
  DEFAULT_COREDOT_GEMINI_BASE_URL,
  normalizeCoreTodayBaseUrl,
} from "./core-today-base-url";

export const DEFAULT_AI_SETTINGS_ID = "default";
export { DEFAULT_COREDOT_ANTHROPIC_BASE_URL, DEFAULT_COREDOT_BASE_URL, DEFAULT_COREDOT_GEMINI_BASE_URL };
export const DEFAULT_COREDOT_MODEL = "gpt-5-nano";
export const DEFAULT_COREDOT_ANTHROPIC_MODEL = "claude-sonnet-4.5";
export const DEFAULT_COREDOT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
export const DEFAULT_COREDOT_MAX_COMPLETION_TOKENS = 32768;

export const aiReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type AiReasoningEffort = z.infer<typeof aiReasoningEffortSchema>;

export const aiSettingsPayloadSchema = z.object({
  aiBaseUrl: z.string().trim().url().nullable().optional(),
  aiMaxCompletionTokens: z.number().int().positive().max(200000).nullable().optional(),
  aiModel: z.string().trim().min(1),
  aiProvider: z.enum(["stub", "openai", "coredot", "anthropic", "gemini"]),
  aiReasoningEffort: aiReasoningEffortSchema.nullable().optional(),
});

export type AiSettingsPayload = z.input<typeof aiSettingsPayloadSchema>;
export type AiSettings = Pick<
  AppSettingsRecord,
  "id" | "aiProvider" | "aiModel" | "aiBaseUrl" | "aiMaxCompletionTokens" | "aiReasoningEffort"
>;

type AiSettingsDatabase = typeof db;

export function createAiSettingsRepository(database: AiSettingsDatabase = db) {
  return {
    async getAiSettings() {
      const [settings] = await database
        .select()
        .from(appSettings)
        .where(eq(appSettings.id, DEFAULT_AI_SETTINGS_ID))
        .limit(1);

      if (settings) {
        return toAiSettings(settings);
      }

      return createDefaultSettings(database);
    },

    async updateAiSettings(input: AiSettingsPayload) {
      const result = aiSettingsPayloadSchema.safeParse(input);
      if (!result.success) {
        throw new Error("Invalid AI settings");
      }

      const now = new Date();
      const normalized = normalizeAiSettingsPayload(result.data);
      const [settings] = await database
        .insert(appSettings)
        .values({
          id: DEFAULT_AI_SETTINGS_ID,
          ...normalized,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.id,
          set: {
            ...normalized,
            updatedAt: now,
          },
        })
        .returning();

      return toAiSettings(settings!);
    },
  };
}

async function createDefaultSettings(database: AiSettingsDatabase) {
  const now = new Date();
  const [settings] = await database
    .insert(appSettings)
    .values({
      id: DEFAULT_AI_SETTINGS_ID,
      ...getDefaultAiSettingsPayload(),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (settings) {
    return toAiSettings(settings);
  }

  const [existingSettings] = await database
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, DEFAULT_AI_SETTINGS_ID))
    .limit(1);
  return toAiSettings(existingSettings!);
}

function getDefaultAiSettingsPayload() {
  const provider = resolveDefaultProvider();

  if (provider === "stub") {
    return normalizeAiSettingsPayload({
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: "stub",
      aiReasoningEffort: null,
    });
  }

  if (provider === "openai") {
    return normalizeAiSettingsPayload({
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      aiProvider: "openai",
      aiReasoningEffort: null,
    });
  }

  if (provider === "anthropic") {
    return normalizeAiSettingsPayload({
      aiBaseUrl: process.env.COREDOT_ANTHROPIC_BASE_URL ?? DEFAULT_COREDOT_ANTHROPIC_BASE_URL,
      aiMaxCompletionTokens:
        readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ??
        DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
      aiModel: process.env.COREDOT_ANTHROPIC_MODEL ?? DEFAULT_COREDOT_ANTHROPIC_MODEL,
      aiProvider: "anthropic",
      aiReasoningEffort: null,
    });
  }

  if (provider === "gemini") {
    return normalizeAiSettingsPayload({
      aiBaseUrl: process.env.COREDOT_GEMINI_BASE_URL ?? DEFAULT_COREDOT_GEMINI_BASE_URL,
      aiMaxCompletionTokens:
        readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ??
        DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
      aiModel: process.env.COREDOT_GEMINI_MODEL ?? DEFAULT_COREDOT_GEMINI_MODEL,
      aiProvider: "gemini",
      aiReasoningEffort: null,
    });
  }

  return normalizeAiSettingsPayload({
    aiBaseUrl: process.env.COREDOT_BASE_URL ?? DEFAULT_COREDOT_BASE_URL,
    aiMaxCompletionTokens:
      readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ??
      DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
    aiModel: process.env.COREDOT_MODEL ?? DEFAULT_COREDOT_MODEL,
    aiProvider: "coredot",
    aiReasoningEffort: null,
  });
}

function resolveDefaultProvider(): z.infer<typeof aiSettingsPayloadSchema>["aiProvider"] {
  if (
    process.env.AI_PROVIDER === "stub" ||
    process.env.AI_PROVIDER === "openai" ||
    process.env.AI_PROVIDER === "coredot" ||
    process.env.AI_PROVIDER === "anthropic" ||
    process.env.AI_PROVIDER === "gemini"
  ) {
    return process.env.AI_PROVIDER;
  }

  if (process.env.COREDOT_API_KEY) {
    return "coredot";
  }

  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }

  return "stub";
}

function normalizeAiSettingsPayload(input: z.infer<typeof aiSettingsPayloadSchema>) {
  if (input.aiProvider === "stub") {
    return {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: input.aiProvider,
      aiReasoningEffort: null,
    };
  }

  if (input.aiProvider === "openai") {
    return {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: input.aiModel.trim() || DEFAULT_OPENAI_MODEL,
      aiProvider: input.aiProvider,
      aiReasoningEffort: input.aiReasoningEffort ?? null,
    };
  }

  if (input.aiProvider === "anthropic") {
    return {
      aiBaseUrl: normalizeCoreTodayBaseUrl("anthropic", input.aiBaseUrl),
      aiMaxCompletionTokens: input.aiMaxCompletionTokens ?? DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
      aiModel: input.aiModel.trim() || DEFAULT_COREDOT_ANTHROPIC_MODEL,
      aiProvider: input.aiProvider,
      aiReasoningEffort: null,
    };
  }

  if (input.aiProvider === "gemini") {
    return {
      aiBaseUrl: normalizeCoreTodayBaseUrl("gemini", input.aiBaseUrl),
      aiMaxCompletionTokens: input.aiMaxCompletionTokens ?? DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
      aiModel: input.aiModel.trim() || DEFAULT_COREDOT_GEMINI_MODEL,
      aiProvider: input.aiProvider,
      aiReasoningEffort: null,
    };
  }

  return {
    aiBaseUrl: normalizeCoreTodayBaseUrl("coredot", input.aiBaseUrl),
    aiMaxCompletionTokens: input.aiMaxCompletionTokens ?? DEFAULT_COREDOT_MAX_COMPLETION_TOKENS,
    aiModel: input.aiModel.trim() || DEFAULT_COREDOT_MODEL,
    aiProvider: input.aiProvider,
    aiReasoningEffort: input.aiReasoningEffort ?? null,
  };
}

function toAiSettings(settings: AppSettingsRecord): AiSettings {
  return {
    aiBaseUrl: normalizeExistingAiSettingsBaseUrl(settings),
    aiMaxCompletionTokens: settings.aiMaxCompletionTokens,
    aiModel: settings.aiModel,
    aiProvider: settings.aiProvider,
    aiReasoningEffort: settings.aiReasoningEffort,
    id: settings.id,
  };
}

function normalizeExistingAiSettingsBaseUrl(settings: AppSettingsRecord) {
  if (settings.aiProvider === "stub" || settings.aiProvider === "openai") {
    return null;
  }

  try {
    return normalizeCoreTodayBaseUrl(settings.aiProvider, settings.aiBaseUrl);
  } catch {
    return normalizeCoreTodayBaseUrl(settings.aiProvider, null);
  }
}

function readOptionalPositiveInteger(value: string | undefined) {
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const defaultRepository = createAiSettingsRepository();

export const getAiSettings = defaultRepository.getAiSettings;
export const updateAiSettings = defaultRepository.updateAiSettings;
