import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createAiSettingsRepository } from "./ai-settings-repository";

const tempDirs: string[] = [];
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

const environmentDefaultCases = [
  {
    environment: { AI_PROVIDER: "stub", COREDOT_MAX_COMPLETION_TOKENS: "123", OPENAI_MODEL: "ignored" },
    expected: {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: "stub",
    },
    provider: "stub",
  },
  {
    environment: { AI_PROVIDER: "openai", OPENAI_MODEL: "environment-openai-model" },
    expected: {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "environment-openai-model",
      aiProvider: "openai",
    },
    provider: "openai",
  },
  {
    environment: {
      AI_PROVIDER: "coredot",
      COREDOT_BASE_URL: "https://api.core.today/llm/openai/v1/",
      COREDOT_MAX_COMPLETION_TOKENS: "123",
      COREDOT_MODEL: "environment-coredot-model",
    },
    expected: {
      aiBaseUrl: "https://api.core.today/llm/openai/v1",
      aiMaxCompletionTokens: 123,
      aiModel: "environment-coredot-model",
      aiProvider: "coredot",
    },
    provider: "coredot",
  },
  {
    environment: {
      AI_PROVIDER: "anthropic",
      COREDOT_ANTHROPIC_BASE_URL: "https://api.core.today/llm/anthropic/v1/",
      COREDOT_ANTHROPIC_MODEL: "environment-anthropic-model",
      COREDOT_MAX_COMPLETION_TOKENS: "456",
    },
    expected: {
      aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
      aiMaxCompletionTokens: 456,
      aiModel: "environment-anthropic-model",
      aiProvider: "anthropic",
    },
    provider: "anthropic",
  },
  {
    environment: {
      AI_PROVIDER: "gemini",
      COREDOT_GEMINI_BASE_URL: "https://api.core.today/llm/gemini/v1beta/",
      COREDOT_GEMINI_MODEL: "environment-gemini-model",
      COREDOT_MAX_COMPLETION_TOKENS: "789",
    },
    expected: {
      aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
      aiMaxCompletionTokens: 789,
      aiModel: "environment-gemini-model",
      aiProvider: "gemini",
    },
    provider: "gemini",
  },
] as const;

const defaultProviderResolutionCases = [
  ...(["stub", "coredot", "anthropic", "gemini", "openai"] as const).map((provider) => ({
    environment: {
      AI_PROVIDER: provider,
      COREDOT_API_KEY: "configured-coredot-key",
      OPENAI_API_KEY: "configured-openai-key",
    },
    expectedProvider: provider,
    name: `explicit ${provider} beats both credentials`,
  })),
  {
    environment: { COREDOT_API_KEY: "configured-coredot-key", OPENAI_API_KEY: "configured-openai-key" },
    expectedProvider: "coredot",
    name: "both credentials prefer coredot",
  },
  {
    environment: { COREDOT_API_KEY: "configured-coredot-key" },
    expectedProvider: "coredot",
    name: "coredot credential selects coredot",
  },
  {
    environment: { OPENAI_API_KEY: "configured-openai-key" },
    expectedProvider: "openai",
    name: "openai credential selects openai",
  },
  {
    environment: {},
    expectedProvider: "stub",
    name: "no explicit provider or credentials selects stub",
  },
  {
    environment: {
      AI_PROVIDER: "invalid-provider",
      COREDOT_API_KEY: "configured-coredot-key",
      OPENAI_API_KEY: "configured-openai-key",
    },
    expectedProvider: "coredot",
    name: "invalid explicit provider with both credentials prefers coredot",
  },
  {
    environment: { AI_PROVIDER: "invalid-provider", COREDOT_API_KEY: "configured-coredot-key" },
    expectedProvider: "coredot",
    name: "invalid explicit provider falls back to coredot credential",
  },
  {
    environment: { AI_PROVIDER: "invalid-provider", OPENAI_API_KEY: "configured-openai-key" },
    expectedProvider: "openai",
    name: "invalid explicit provider falls back to openai credential",
  },
  {
    environment: { AI_PROVIDER: "invalid-provider" },
    expectedProvider: "stub",
    name: "invalid explicit provider without credentials falls back to stub",
  },
] as const;

const catalogFallbackCases = [
  {
    expected: { aiBaseUrl: null, aiMaxCompletionTokens: null, aiModel: "stub-editor" },
    provider: "stub",
  },
  {
    expected: {
      aiBaseUrl: "https://api.core.today/llm/openai/v1",
      aiMaxCompletionTokens: 32768,
      aiModel: "gpt-5-nano",
    },
    provider: "coredot",
  },
  {
    expected: {
      aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
      aiMaxCompletionTokens: 32768,
      aiModel: "claude-sonnet-4.5",
    },
    provider: "anthropic",
  },
  {
    expected: {
      aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
      aiMaxCompletionTokens: 32768,
      aiModel: "gemini-2.5-flash",
    },
    provider: "gemini",
  },
  {
    expected: { aiBaseUrl: null, aiMaxCompletionTokens: null, aiModel: "gpt-4.1-mini" },
    provider: "openai",
  },
] as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedSettingsDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-ai-settings-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "settings.db")}` });
  const db = drizzle(client, { schema });

  await db.run(sql`
    CREATE TABLE app_settings (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL UNIQUE,
      ai_provider text DEFAULT 'coredot' NOT NULL,
      ai_model text DEFAULT 'gpt-5-nano' NOT NULL,
      ai_base_url text,
      ai_max_completion_tokens integer,
      ai_reasoning_effort text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);

  return db;
}

describe("AI settings repository", () => {
  it("creates safe local defaults when no model provider is configured", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalCoreDotKey = process.env.COREDOT_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.COREDOT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    try {
      const settings = await repository.getAiSettings(workspaceA);

      expect(settings).toMatchObject({
        aiBaseUrl: null,
        aiMaxCompletionTokens: null,
        aiModel: "stub-editor",
        aiProvider: "stub",
        aiReasoningEffort: null,
        workspaceId: workspaceA.workspaceId,
      });
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalCoreDotKey === undefined) {
        delete process.env.COREDOT_API_KEY;
      } else {
        process.env.COREDOT_API_KEY = originalCoreDotKey;
      }

      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("creates Core.Today defaults when the Core.Today provider is configured", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "coredot";
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    try {
      const settings = await repository.getAiSettings(workspaceA);

      expect(settings).toMatchObject({
        aiBaseUrl: "https://api.core.today/llm/openai/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: null,
        workspaceId: workspaceA.workspaceId,
      });
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }
    }
  });

  it.each(environmentDefaultCases)(
    "creates normalized $provider defaults from provider-specific environment settings",
    async ({ environment, expected }) => {
      await withCleanSettingsEnvironment(environment, async () => {
        const db = await createIsolatedSettingsDb();
        const repository = createAiSettingsRepository(db);

        await expect(repository.getAiSettings(workspaceA)).resolves.toMatchObject({
          ...expected,
          aiReasoningEffort: null,
          workspaceId: workspaceA.workspaceId,
        });
      });
    },
  );

  it.each(defaultProviderResolutionCases)(
    "resolves the default provider when $name",
    async ({ environment, expectedProvider }) => {
      await withCleanSettingsEnvironment(environment, async () => {
        const db = await createIsolatedSettingsDb();
        const repository = createAiSettingsRepository(db);

        await expect(repository.getAiSettings(workspaceA)).resolves.toMatchObject({
          aiProvider: expectedProvider,
          workspaceId: workspaceA.workspaceId,
        });
      });
    },
  );

  it.each(catalogFallbackCases)(
    "uses exact $provider catalog defaults when optional provider environment is absent",
    async ({ expected, provider }) => {
      await withCleanSettingsEnvironment({ AI_PROVIDER: provider }, async () => {
        const db = await createIsolatedSettingsDb();
        const repository = createAiSettingsRepository(db);

        await expect(repository.getAiSettings(workspaceA)).resolves.toMatchObject({
          ...expected,
          aiProvider: provider,
          aiReasoningEffort: null,
          workspaceId: workspaceA.workspaceId,
        });
      });
    },
  );

  it("normalizes stub settings so browser clients cannot configure secrets", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    const settings = await repository.updateAiSettings(workspaceA, {
      aiBaseUrl: "https://should-not-stick.example.test/v1",
      aiMaxCompletionTokens: 999,
      aiModel: "ignored-model",
      aiProvider: "stub",
      aiReasoningEffort: "high",
    });

    expect(settings).toMatchObject({
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: "stub",
      aiReasoningEffort: null,
    });
  });

  it("normalizes Anthropic and Gemini Core.Today proxy settings", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    const anthropicSettings = await repository.updateAiSettings(workspaceA, {
      aiBaseUrl: null,
      aiMaxCompletionTokens: 8192,
      aiModel: "claude-sonnet-4.5",
      aiProvider: "anthropic",
      aiReasoningEffort: "high",
    });
    const geminiSettings = await repository.updateAiSettings(workspaceA, {
      aiBaseUrl: null,
      aiMaxCompletionTokens: 4096,
      aiModel: "gemini-2.5-flash",
      aiProvider: "gemini",
      aiReasoningEffort: "medium",
    });

    expect(anthropicSettings).toMatchObject({
      aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
      aiMaxCompletionTokens: 8192,
      aiModel: "claude-sonnet-4.5",
      aiProvider: "anthropic",
      aiReasoningEffort: null,
    });
    expect(geminiSettings).toMatchObject({
      aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
      aiMaxCompletionTokens: 4096,
      aiModel: "gemini-2.5-flash",
      aiProvider: "gemini",
      aiReasoningEffort: null,
    });
  });

  it("validates Core.Today settings before saving", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    await expect(
      repository.updateAiSettings(workspaceA, {
        aiBaseUrl: "not-a-url",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: "medium",
      }),
    ).rejects.toThrow("Invalid AI settings");
  });

  it("rejects non-Core.Today proxy URLs before saving provider settings", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    await expect(
      repository.updateAiSettings(workspaceA, {
        aiBaseUrl: "https://attacker.example.test/llm/openai/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: "medium",
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings(workspaceA, {
        aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
        aiMaxCompletionTokens: 32768,
        aiModel: "claude-sonnet-4.5",
        aiProvider: "anthropic",
        aiReasoningEffort: null,
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings(workspaceA, {
        aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: null,
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings(workspaceA, {
        aiBaseUrl: "https://api.core.today:444/llm/gemini/v1beta",
        aiMaxCompletionTokens: 32768,
        aiModel: "gemini-2.5-flash",
        aiProvider: "gemini",
        aiReasoningEffort: null,
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");
  });

  it("sanitizes stale persisted Core.Today URLs before returning settings", async () => {
    const db = await createIsolatedSettingsDb();
    await db.insert(schema.appSettings).values({
      aiBaseUrl: "https://attacker.example.test/llm/openai/v1",
      aiMaxCompletionTokens: 32768,
      aiModel: "gpt-5-nano",
      aiProvider: "coredot",
      aiReasoningEffort: null,
      createdAt: new Date(),
      id: "default",
      workspaceId: workspaceA.workspaceId,
      updatedAt: new Date(),
    });
    const repository = createAiSettingsRepository(db);

    const settings = await repository.getAiSettings(workspaceA);

    expect(settings.aiBaseUrl).toBe("https://api.core.today/llm/openai/v1");
  });

  it("keeps each workspace's AI settings isolated", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    await repository.updateAiSettings(workspaceA, {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "gpt-4.1-mini",
      aiProvider: "openai",
      aiReasoningEffort: "medium",
    });

    const workspaceBSettings = await repository.getAiSettings(workspaceB);
    expect(workspaceBSettings).toMatchObject({
      aiModel: "stub-editor",
      aiProvider: "stub",
      workspaceId: workspaceB.workspaceId,
    });

    await repository.updateAiSettings(workspaceB, {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "ignored",
      aiProvider: "stub",
      aiReasoningEffort: null,
    });

    await expect(repository.getAiSettings(workspaceA)).resolves.toMatchObject({
      aiModel: "gpt-4.1-mini",
      aiProvider: "openai",
      workspaceId: workspaceA.workspaceId,
    });
  });
});

const settingsEnvironmentKeys = [
  "AI_PROVIDER",
  "COREDOT_API_KEY",
  "OPENAI_API_KEY",
  "COREDOT_BASE_URL",
  "COREDOT_MODEL",
  "COREDOT_ANTHROPIC_BASE_URL",
  "COREDOT_ANTHROPIC_MODEL",
  "COREDOT_GEMINI_BASE_URL",
  "COREDOT_GEMINI_MODEL",
  "COREDOT_MAX_COMPLETION_TOKENS",
  "OPENAI_MODEL",
] as const;

async function withCleanSettingsEnvironment<Result>(
  environment: Record<string, string | undefined>,
  run: () => Result | Promise<Result>,
) {
  const originalEnvironment = Object.fromEntries(settingsEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of settingsEnvironmentKeys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const key of settingsEnvironmentKeys) {
      const originalValue = originalEnvironment[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}
