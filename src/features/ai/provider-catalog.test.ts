import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appSettings } from "@/db/schema";
import {
  AI_PROVIDER_CAPABILITIES,
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_EDITABLE_SETTINGS,
  AI_PROVIDER_IDS,
  AI_REASONING_EFFORTS,
  getAiProviderCapabilities,
  getAiProviderDefinition,
  isCoreTodayProviderName,
  isAiProviderName,
  isAiProviderSettingEditable,
  type AiProviderEditableSetting,
  type AiProviderName,
} from "./provider-catalog";

const expectedProviderMetadata = [
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
] as const;

describe("AI provider catalog", () => {
  it("defines every persisted provider exactly once in the required order", () => {
    const persistedProviders = [...appSettings.aiProvider.enumValues].sort();
    const catalogIds = AI_PROVIDER_CATALOG.map((definition) => definition.id);

    expect(AI_PROVIDER_IDS).toEqual(["stub", "coredot", "anthropic", "gemini", "openai"]);
    expect(catalogIds).toEqual(AI_PROVIDER_IDS);
    expect([...new Set(catalogIds)]).toHaveLength(catalogIds.length);
    expect([...catalogIds].sort()).toEqual(persistedProviders);
  });

  it("derives the ordered provider ID tuple from the catalog entries", async () => {
    const catalogPath = resolve(dirname(fileURLToPath(import.meta.url)), "provider-catalog.ts");
    const catalogSource = await readFile(catalogPath, "utf8");

    expect(catalogSource).not.toMatch(/AI_PROVIDER_IDS\s*=\s*\[/);
    expect(catalogSource).toMatch(/AI_PROVIDER_IDS\s*=\s*deriveProviderIds\(AI_PROVIDER_CATALOG\)/);
    expect(Object.isFrozen(AI_PROVIDER_IDS)).toBe(true);
  });

  it("contains the complete provider metadata and editable-setting rules", () => {
    expect(AI_PROVIDER_CATALOG).toEqual(expectedProviderMetadata);

    const expectedEditableSettings: Record<AiProviderName, readonly AiProviderEditableSetting[]> = {
      anthropic: ["model", "baseUrl", "maxCompletionTokens"],
      coredot: ["model", "baseUrl", "maxCompletionTokens", "reasoningEffort"],
      gemini: ["model", "baseUrl", "maxCompletionTokens"],
      openai: ["model", "reasoningEffort"],
      stub: [],
    };

    for (const provider of AI_PROVIDER_IDS) {
      for (const setting of AI_PROVIDER_EDITABLE_SETTINGS) {
        expect(isAiProviderSettingEditable(provider, setting)).toBe(expectedEditableSettings[provider].includes(setting));
      }
    }
  });

  it("defines reasoning efforts once in the UI display order without duplicates", () => {
    expect(AI_REASONING_EFFORTS).toEqual(["minimal", "low", "medium", "high", "none", "xhigh"]);
    expect(new Set(AI_REASONING_EFFORTS).size).toBe(AI_REASONING_EFFORTS.length);
  });

  it("provides typed, immutable, credential-free lookups", () => {
    expect(isAiProviderName("coredot")).toBe(true);
    expect(isAiProviderName("unknown")).toBe(false);
    expect(isAiProviderName(null)).toBe(false);
    expect(isCoreTodayProviderName("coredot")).toBe(true);
    expect(isCoreTodayProviderName("anthropic")).toBe(true);
    expect(isCoreTodayProviderName("gemini")).toBe(true);
    expect(isCoreTodayProviderName("openai")).toBe(false);
    expect(getAiProviderDefinition("gemini").defaultModel).toBe("gemini-2.5-flash");
    expect(getAiProviderCapabilities("coredot")).toBe(AI_PROVIDER_CAPABILITIES.coredot);
    expect(getAiProviderCapabilities("coredot")).toEqual({
      coreTodayProxy: true,
      reasoningEffort: true,
      streaming: "native",
      structuredReview: true,
    });
    expect(Object.isFrozen(AI_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(getAiProviderDefinition("coredot"))).toBe(true);
    expect(Object.isFrozen(getAiProviderCapabilities("coredot"))).toBe(true);
  });
});

describe("browser AI import boundary", () => {
  it("marks the runtime adapters as server-only", async () => {
    const adapterPath = resolve(dirname(fileURLToPath(import.meta.url)), "provider-adapters.ts");
    const adapterSource = await readFile(adapterPath, "utf8");

    expect(adapterSource).toMatch(/^import "server-only";/);
  });

  it("keeps the provider catalog and client dialog dependency closure free of server runtime code", async () => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const entrypoints = [
      resolve(sourceRoot, "features/ai/provider-catalog.ts"),
      resolve(sourceRoot, "components/settings/AiSettingsDialog.tsx"),
    ];
    const closure = await walkSourceDependencies(entrypoints, sourceRoot);
    const relativeFiles = [...closure.files].map((file) => file.slice(sourceRoot.length + 1)).sort();
    const combinedSource = [...closure.sources.values()].join("\n");

    expect(relativeFiles).not.toContain("features/ai/provider-adapters.ts");
    expect(relativeFiles).not.toContain("features/ai/providers.ts");
    expect(relativeFiles).not.toContain("features/ai/ai-settings-repository.ts");
    expect([...closure.externalImports]).not.toContain("@ai-sdk/openai");
    expect([...closure.externalImports]).not.toContain("ai");
    expect([...closure.externalImports]).not.toContain("server-only");
    expect(combinedSource).not.toMatch(/process\.env/);
    expect(combinedSource).not.toMatch(/(?:COREDOT|OPENAI)_(?:API_KEY|MODEL|BASE_URL|MAX_COMPLETION_TOKENS)/);
  });
});

async function walkSourceDependencies(entrypoints: string[], sourceRoot: string) {
  const files = new Set<string>();
  const externalImports = new Set<string>();
  const sources = new Map<string, string>();
  const pending = [...entrypoints];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;

    files.add(file);
    const source = await readFile(file, "utf8");
    sources.set(file, source);

    for (const specifier of readImportSpecifiers(source)) {
      const dependency = await resolveSourceDependency(file, specifier, sourceRoot);
      if (dependency) {
        pending.push(dependency);
      } else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        externalImports.add(specifier);
      }
    }
  }

  return { externalImports, files, sources };
}

function readImportSpecifiers(source: string) {
  const specifiers: string[] = [];
  const pattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\))/g;

  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1] ?? match[2]);
  }

  return specifiers;
}

async function resolveSourceDependency(importer: string, specifier: string, sourceRoot: string) {
  const unresolved = specifier.startsWith("@/")
    ? resolve(sourceRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(importer), specifier)
      : null;
  if (!unresolved) return null;

  const candidates = extname(unresolved)
    ? [unresolved]
    : [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.js`,
        `${unresolved}.jsx`,
        resolve(unresolved, "index.ts"),
        resolve(unresolved, "index.tsx"),
      ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking supported source-file candidates.
    }
  }

  throw new Error(`Unable to resolve source dependency ${specifier} from ${importer}`);
}
