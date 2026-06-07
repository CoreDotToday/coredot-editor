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
      const settings = await repository.getAiSettings();

      expect(settings).toMatchObject({
        aiBaseUrl: null,
        aiMaxCompletionTokens: null,
        aiModel: "stub-editor",
        aiProvider: "stub",
        aiReasoningEffort: null,
        id: "default",
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
      const settings = await repository.getAiSettings();

      expect(settings).toMatchObject({
        aiBaseUrl: "https://api.core.today/llm/openai/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: null,
        id: "default",
      });
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }
    }
  });

  it("normalizes stub settings so browser clients cannot configure secrets", async () => {
    const db = await createIsolatedSettingsDb();
    const repository = createAiSettingsRepository(db);

    const settings = await repository.updateAiSettings({
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

    const anthropicSettings = await repository.updateAiSettings({
      aiBaseUrl: null,
      aiMaxCompletionTokens: 8192,
      aiModel: "claude-sonnet-4.5",
      aiProvider: "anthropic",
      aiReasoningEffort: "high",
    });
    const geminiSettings = await repository.updateAiSettings({
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
      repository.updateAiSettings({
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
      repository.updateAiSettings({
        aiBaseUrl: "https://attacker.example.test/llm/openai/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: "medium",
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings({
        aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
        aiMaxCompletionTokens: 32768,
        aiModel: "claude-sonnet-4.5",
        aiProvider: "anthropic",
        aiReasoningEffort: null,
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings({
        aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: null,
      }),
    ).rejects.toThrow("Invalid Core.Today base URL");

    await expect(
      repository.updateAiSettings({
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
      updatedAt: new Date(),
    });
    const repository = createAiSettingsRepository(db);

    const settings = await repository.getAiSettings();

    expect(settings.aiBaseUrl).toBe("https://api.core.today/llm/openai/v1");
  });
});
