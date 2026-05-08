import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createPromptTemplateRepository } from "./template-repository";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedTemplateDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-template-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "templates.db")}` });
  const db = drizzle(client, { schema });

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

  return db;
}

describe("template repository", () => {
  it("excludes archived templates from manager listings", async () => {
    const db = await createIsolatedTemplateDb();
    const { archivePromptTemplate, createPromptTemplate, listPromptTemplates } = createPromptTemplateRepository(db);
    const activeTemplate = await createPromptTemplate({
      name: "Active Review",
      description: "Active",
      category: "custom",
      systemPrompt: "You are active.",
      variableSchemaJson: { fields: [], required: [] },
    });
    const archivedTemplate = await createPromptTemplate({
      name: "Archived Review",
      description: "Archived",
      category: "custom",
      systemPrompt: "You are archived.",
      variableSchemaJson: { fields: [], required: [] },
    });

    await archivePromptTemplate(archivedTemplate.id);

    const templates = await listPromptTemplates();

    expect(templates.map((template) => template.id)).toEqual([activeTemplate.id]);
  });

  it("does not update archived templates", async () => {
    const db = await createIsolatedTemplateDb();
    const { archivePromptTemplate, createPromptTemplate, updatePromptTemplate } = createPromptTemplateRepository(db);
    const template = await createPromptTemplate({
      name: "Archived Review",
      description: "Archived",
      category: "custom",
      systemPrompt: "You are archived.",
      variableSchemaJson: { fields: [], required: [] },
    });
    await archivePromptTemplate(template.id);

    const updatedTemplate = await updatePromptTemplate(template.id, {
      name: "Reactivated Review",
      description: "Reactivated",
      category: "custom",
      systemPrompt: "You are reactivated.",
      variableSchemaJson: { fields: [], required: [] },
      isActive: true,
    });

    expect(updatedTemplate).toBeNull();
  });

  it("returns null when archiving an already archived template", async () => {
    const db = await createIsolatedTemplateDb();
    const { archivePromptTemplate, createPromptTemplate } = createPromptTemplateRepository(db);
    const template = await createPromptTemplate({
      name: "Archived Review",
      description: "Archived",
      category: "custom",
      systemPrompt: "You are archived.",
      variableSchemaJson: { fields: [], required: [] },
    });

    expect(await archivePromptTemplate(template.id)).not.toBeNull();
    await expect(archivePromptTemplate(template.id)).resolves.toBeNull();
  });
});
