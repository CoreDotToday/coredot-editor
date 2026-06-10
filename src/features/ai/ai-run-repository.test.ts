import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createAiRunRepository } from "./ai-run-repository";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedAiRunDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-ai-run-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "ai-runs.db")}` });
  const db = drizzle(client, { schema });

  await db.run(sql`
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      readiness text DEFAULT 'draft' NOT NULL,
      metadata_json text DEFAULT '{}' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
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
  await db.run(sql`
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL,
      document_id text NOT NULL,
      prompt_template_id text,
      command_type text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      input_summary_json text NOT NULL,
      output_text text DEFAULT '' NOT NULL,
      status text NOT NULL,
      was_applied integer DEFAULT false NOT NULL,
      error_message text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL,
      ai_run_id text NOT NULL,
      document_id text NOT NULL,
      target_text text NOT NULL,
      replacement_text text NOT NULL,
      explanation text NOT NULL,
      source text DEFAULT 'review' NOT NULL,
      command text,
      occurrence_index integer,
      target_from integer,
      target_to integer,
      default_apply_mode text DEFAULT 'replace' NOT NULL,
      applied_mode text,
      status text DEFAULT 'pending' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      CONSTRAINT "no_bad_targets" CHECK(target_text <> 'bad')
    )
  `);

  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(schema.documents).values({
    id: "doc_1",
    title: "Memo",
    contentJson: { type: "doc" },
    plainText: "Text",
    readiness: "draft",
    metadataJson: {},
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.promptTemplates).values({
    id: "tpl_1",
    name: "Review",
    description: "Review",
    category: "strategy",
    systemPrompt: "Review.",
    variableSchemaJson: { fields: [], required: [] },
    isDefault: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return db;
}

describe("AI run repository", () => {
  it("creates pending runs and completes or fails them consistently", async () => {
    const db = await createIsolatedAiRunDb();
    const repository = createAiRunRepository(db);

    const run = await repository.createAiRun({
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "selection_rewrite",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: { selectedTextLength: 4 },
    });
    const completedRun = await repository.completeAiRun(run.id, "New text");
    const failedRun = await repository.failAiRun(run.id, "late failure");
    const runs = await repository.listAiRunsForDocument("doc_1");

    expect(run.status).toBe("pending");
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.outputText).toBe("New text");
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorMessage).toBe("late failure");
    expect(runs).toHaveLength(1);
  });

  it("rolls back proposal inserts when finalizing an AI run fails", async () => {
    const db = await createIsolatedAiRunDb();
    const repository = createAiRunRepository(db);
    const run = await repository.createAiRun({
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: { documentTextLength: 4 },
    });

    await expect(
      repository.completeAiRunWithProposals(run.id, "review output", [
        {
          documentId: "doc_1",
          targetText: "good",
          replacementText: "better",
          explanation: "Valid.",
        },
        {
          documentId: "doc_1",
          targetText: "bad",
          replacementText: "worse",
          explanation: "Should trigger rollback.",
        },
      ]),
    ).rejects.toThrow();

    const [savedRun] = await db.select().from(schema.aiRuns).where(sql`${schema.aiRuns.id} = ${run.id}`);
    const proposals = await db.select().from(schema.aiProposals);

    expect(savedRun?.status).toBe("pending");
    expect(proposals).toHaveLength(0);
  });
});
