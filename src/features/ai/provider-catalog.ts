export const AI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "none", "xhigh"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export const AI_PROVIDER_EDITABLE_SETTINGS = [
  "baseUrl",
  "maxCompletionTokens",
  "model",
  "reasoningEffort",
] as const;
export type AiProviderEditableSetting = (typeof AI_PROVIDER_EDITABLE_SETTINGS)[number];

export type AiProviderCapabilities = {
  coreTodayProxy: boolean;
  reasoningEffort: boolean;
  streaming: "buffered" | "native";
  structuredReview: boolean;
};

type AiProviderDefinitionShape = {
  capabilities: AiProviderCapabilities;
  defaultBaseUrl: string | null;
  defaultMaxCompletionTokens: number | null;
  defaultModel: string;
  editableSettings: readonly AiProviderEditableSetting[];
  id: string;
  label: string;
};

export const AI_PROVIDER_CATALOG = Object.freeze([
  defineAiProvider({
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
    defaultBaseUrl: null,
    defaultMaxCompletionTokens: null,
    defaultModel: "stub-editor",
    editableSettings: [],
    id: "stub",
    label: "로컬 Stub",
  }),
  defineAiProvider({
    capabilities: {
      coreTodayProxy: true,
      reasoningEffort: true,
      streaming: "native",
      structuredReview: true,
    },
    defaultBaseUrl: "https://api.core.today/llm/openai/v1",
    defaultMaxCompletionTokens: 32768,
    defaultModel: "gpt-5-nano",
    editableSettings: ["model", "baseUrl", "maxCompletionTokens", "reasoningEffort"],
    id: "coredot",
    label: "Core.Today",
  }),
  defineAiProvider({
    capabilities: {
      coreTodayProxy: true,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
    defaultBaseUrl: "https://api.core.today/llm/anthropic/v1",
    defaultMaxCompletionTokens: 32768,
    defaultModel: "claude-sonnet-4.5",
    editableSettings: ["model", "baseUrl", "maxCompletionTokens"],
    id: "anthropic",
    label: "Anthropic (Core.Today)",
  }),
  defineAiProvider({
    capabilities: {
      coreTodayProxy: true,
      reasoningEffort: false,
      streaming: "buffered",
      structuredReview: true,
    },
    defaultBaseUrl: "https://api.core.today/llm/gemini/v1beta",
    defaultMaxCompletionTokens: 32768,
    defaultModel: "gemini-2.5-flash",
    editableSettings: ["model", "baseUrl", "maxCompletionTokens"],
    id: "gemini",
    label: "Gemini (Core.Today)",
  }),
  defineAiProvider({
    capabilities: {
      coreTodayProxy: false,
      reasoningEffort: true,
      streaming: "native",
      structuredReview: true,
    },
    defaultBaseUrl: null,
    defaultMaxCompletionTokens: null,
    defaultModel: "gpt-4.1-mini",
    editableSettings: ["model", "reasoningEffort"],
    id: "openai",
    label: "OpenAI",
  }),
] as const);

export type AiProviderDefinition = (typeof AI_PROVIDER_CATALOG)[number];
export type AiProviderName = AiProviderDefinition["id"];
export const AI_PROVIDER_IDS = deriveProviderIds(AI_PROVIDER_CATALOG);

type AiProviderCatalogById = {
  [Definition in AiProviderDefinition as Definition["id"]]: Definition;
};

const AI_PROVIDER_CATALOG_BY_ID = Object.freeze(
  Object.fromEntries(AI_PROVIDER_CATALOG.map((definition) => [definition.id, definition])),
) as AiProviderCatalogById;

export const AI_PROVIDER_CAPABILITIES = Object.freeze(
  Object.fromEntries(AI_PROVIDER_CATALOG.map((definition) => [definition.id, definition.capabilities])),
) as Readonly<Record<AiProviderName, AiProviderCapabilities>>;

export function isAiProviderName(value: unknown): value is AiProviderName {
  return typeof value === "string" && Object.hasOwn(AI_PROVIDER_CATALOG_BY_ID, value);
}

export function isCoreTodayProviderName(
  value: unknown,
): value is Extract<AiProviderName, "coredot" | "anthropic" | "gemini"> {
  return isAiProviderName(value) && getAiProviderDefinition(value).capabilities.coreTodayProxy;
}

export function getAiProviderDefinition<Provider extends AiProviderName>(provider: Provider) {
  return AI_PROVIDER_CATALOG_BY_ID[provider];
}

export function getAiProviderCapabilities(provider: AiProviderName) {
  return AI_PROVIDER_CAPABILITIES[provider];
}

export function isAiProviderSettingEditable(provider: AiProviderName, setting: AiProviderEditableSetting) {
  const editableSettings: readonly AiProviderEditableSetting[] = getAiProviderDefinition(provider).editableSettings;
  return editableSettings.includes(setting);
}

function defineAiProvider<const Definition extends AiProviderDefinitionShape>(definition: Definition) {
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze(definition.capabilities),
    editableSettings: Object.freeze(definition.editableSettings),
  });
}

type ProviderIdTuple<Definitions extends readonly { id: string }[]> = {
  readonly [Index in keyof Definitions]: Definitions[Index] extends { id: infer Id extends string } ? Id : never;
};

function deriveProviderIds<const Definitions extends readonly { id: string }[]>(definitions: Definitions) {
  return Object.freeze(definitions.map((definition) => definition.id)) as ProviderIdTuple<Definitions>;
}
