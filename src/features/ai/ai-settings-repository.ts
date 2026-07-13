import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { appSettings, type AppSettingsRecord } from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";
import {
  DEFAULT_COREDOT_ANTHROPIC_BASE_URL,
  DEFAULT_COREDOT_BASE_URL,
  DEFAULT_COREDOT_GEMINI_BASE_URL,
  normalizeCoreTodayBaseUrl,
} from "./core-today-base-url";
import {
  AI_PROVIDER_IDS,
  AI_REASONING_EFFORTS,
  getAiProviderDefinition,
  isAiProviderName,
  isAiProviderSettingEditable,
  isCoreTodayProviderName,
  type AiProviderName,
  type AiReasoningEffort,
} from "./provider-catalog";

export { DEFAULT_COREDOT_ANTHROPIC_BASE_URL, DEFAULT_COREDOT_BASE_URL, DEFAULT_COREDOT_GEMINI_BASE_URL };
export const DEFAULT_COREDOT_MODEL = getAiProviderDefinition("coredot").defaultModel;
export const DEFAULT_COREDOT_ANTHROPIC_MODEL = getAiProviderDefinition("anthropic").defaultModel;
export const DEFAULT_COREDOT_GEMINI_MODEL = getAiProviderDefinition("gemini").defaultModel;
export const DEFAULT_OPENAI_MODEL = getAiProviderDefinition("openai").defaultModel;
export const DEFAULT_COREDOT_MAX_COMPLETION_TOKENS =
  getAiProviderDefinition("coredot").defaultMaxCompletionTokens;

export const aiReasoningEffortSchema = z.enum(AI_REASONING_EFFORTS);
export type { AiReasoningEffort };

export const aiSettingsPayloadSchema = z.object({
  aiBaseUrl: z.string().trim().url().nullable().optional(),
  aiMaxCompletionTokens: z.number().int().positive().max(200000).nullable().optional(),
  aiModel: z.string().trim().min(1),
  aiProvider: z.enum(AI_PROVIDER_IDS),
  aiReasoningEffort: aiReasoningEffortSchema.nullable().optional(),
});

export type AiSettingsPayload = z.input<typeof aiSettingsPayloadSchema>;
export type AiSettings = Pick<
  AppSettingsRecord,
  "id" | "workspaceId" | "aiProvider" | "aiModel" | "aiBaseUrl" | "aiMaxCompletionTokens" | "aiReasoningEffort"
>;

type AiSettingsDatabase = typeof db;

export function createAiSettingsRepository(database: AiSettingsDatabase = db) {
  return {
    async getAiSettings(scope: WorkspaceScope) {
      const [settings] = await database
        .select()
        .from(appSettings)
        .where(eq(appSettings.workspaceId, scope.workspaceId))
        .limit(1);

      if (settings) {
        return toAiSettings(settings);
      }

      return createDefaultSettings(database, scope);
    },

    async updateAiSettings(scope: WorkspaceScope, input: AiSettingsPayload) {
      const result = aiSettingsPayloadSchema.safeParse(input);
      if (!result.success) {
        throw new Error("Invalid AI settings");
      }

      const now = new Date();
      const normalized = normalizeAiSettingsPayload(result.data);
      const [settings] = await database
        .insert(appSettings)
        .values({
          workspaceId: scope.workspaceId,
          ...normalized,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.workspaceId,
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

async function createDefaultSettings(database: AiSettingsDatabase, scope: WorkspaceScope) {
  const now = new Date();
  const [settings] = await database
    .insert(appSettings)
    .values({
      workspaceId: scope.workspaceId,
      ...getDefaultAiSettingsPayload(),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: appSettings.workspaceId })
    .returning();

  if (settings) {
    return toAiSettings(settings);
  }

  const [existingSettings] = await database
    .select()
    .from(appSettings)
    .where(eq(appSettings.workspaceId, scope.workspaceId))
    .limit(1);
  return toAiSettings(existingSettings!);
}

function getDefaultAiSettingsPayload() {
  const provider = resolveDefaultProvider();
  const definition = getAiProviderDefinition(provider);
  return normalizeAiSettingsPayload({
    aiBaseUrl: readProviderBaseUrl(provider) ?? definition.defaultBaseUrl,
    aiMaxCompletionTokens: isAiProviderSettingEditable(provider, "maxCompletionTokens")
      ? readOptionalPositiveInteger(process.env.COREDOT_MAX_COMPLETION_TOKENS) ??
        definition.defaultMaxCompletionTokens
      : null,
    aiModel: readProviderModel(provider) ?? definition.defaultModel,
    aiProvider: provider,
    aiReasoningEffort: null,
  });
}

function resolveDefaultProvider(): z.infer<typeof aiSettingsPayloadSchema>["aiProvider"] {
  if (isAiProviderName(process.env.AI_PROVIDER)) {
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
  const definition = getAiProviderDefinition(input.aiProvider);
  return {
    aiBaseUrl: isCoreTodayProviderName(input.aiProvider)
      ? normalizeCoreTodayBaseUrl(input.aiProvider, input.aiBaseUrl)
      : null,
    aiMaxCompletionTokens: isAiProviderSettingEditable(input.aiProvider, "maxCompletionTokens")
      ? input.aiMaxCompletionTokens ?? definition.defaultMaxCompletionTokens
      : null,
    aiModel: isAiProviderSettingEditable(input.aiProvider, "model")
      ? input.aiModel.trim() || definition.defaultModel
      : definition.defaultModel,
    aiProvider: input.aiProvider,
    aiReasoningEffort: isAiProviderSettingEditable(input.aiProvider, "reasoningEffort")
      ? input.aiReasoningEffort ?? null
      : null,
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
    workspaceId: settings.workspaceId,
  };
}

function normalizeExistingAiSettingsBaseUrl(settings: AppSettingsRecord) {
  if (!isCoreTodayProviderName(settings.aiProvider)) {
    return null;
  }

  try {
    return normalizeCoreTodayBaseUrl(settings.aiProvider, settings.aiBaseUrl);
  } catch {
    return normalizeCoreTodayBaseUrl(settings.aiProvider, null);
  }
}

function readProviderBaseUrl(provider: AiProviderName) {
  if (provider === "coredot") return process.env.COREDOT_BASE_URL;
  if (provider === "anthropic") return process.env.COREDOT_ANTHROPIC_BASE_URL;
  if (provider === "gemini") return process.env.COREDOT_GEMINI_BASE_URL;
  return undefined;
}

function readProviderModel(provider: AiProviderName) {
  if (provider === "coredot") return process.env.COREDOT_MODEL;
  if (provider === "anthropic") return process.env.COREDOT_ANTHROPIC_MODEL;
  if (provider === "gemini") return process.env.COREDOT_GEMINI_MODEL;
  if (provider === "openai") return process.env.OPENAI_MODEL;
  return undefined;
}

function readOptionalPositiveInteger(value: string | undefined) {
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const defaultRepository = createAiSettingsRepository();

export const getAiSettings = defaultRepository.getAiSettings;
export const updateAiSettings = defaultRepository.updateAiSettings;
