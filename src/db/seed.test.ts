import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptTemplates } from "./schema";
import { defaultPromptTemplates, seedDefaultPromptTemplates } from "./seed";

const originalDatabaseUrl = process.env.DATABASE_URL;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedPromptTemplateDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-seed-test-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "seed.db")}`;
  const client = createClient({ url });
  const db = drizzle(client);

  await db.run(sql`
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      description text NOT NULL,
      category text NOT NULL,
      system_prompt text NOT NULL,
      variable_schema_json text NOT NULL,
      is_default integer DEFAULT false NOT NULL,
      is_active integer DEFAULT true NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);

  return { db, url };
}

describe("defaultPromptTemplates", () => {
  it("ships business strategy templates with editable prompt variables", () => {
    expect(defaultPromptTemplates).toHaveLength(3);
    expect(defaultPromptTemplates.map((template) => template.id)).toEqual([
      "tpl_strategy_review",
      "tpl_executive_rewrite",
      "tpl_market_research",
    ]);
    expect(defaultPromptTemplates.map((template) => template.category)).toEqual([
      "strategy_review",
      "executive_rewrite",
      "market_research",
    ]);
    expect(defaultPromptTemplates[0]?.variableSchema.required).toContain("audience");
    expect(defaultPromptTemplates[0]?.systemPrompt).toContain("business strategy editor");
  });
});

describe("seedDefaultPromptTemplates", () => {
  it("uses stable primary keys to seed exactly three defaults idempotently", async () => {
    const { db, url } = await createIsolatedPromptTemplateDb();
    process.env.DATABASE_URL = url;

    await seedDefaultPromptTemplates(new Date("2026-01-01T00:00:00.000Z"));
    await seedDefaultPromptTemplates(new Date("2026-01-02T00:00:00.000Z"));

    const rows = await db
      .select({
        id: promptTemplates.id,
        name: promptTemplates.name,
        isDefault: promptTemplates.isDefault,
      })
      .from(promptTemplates)
      .orderBy(promptTemplates.id);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "tpl_executive_rewrite",
      "tpl_market_research",
      "tpl_strategy_review",
    ]);
    expect(rows.every((row) => row.isDefault)).toBe(true);
  });
});
