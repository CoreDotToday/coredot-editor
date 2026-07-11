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
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedAiRunDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-ai-run-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "ai-runs.db")}` });
  const db = drizzle(client, { schema });
  await db.run(sql`PRAGMA foreign_keys = ON`);

  await db.run(sql`
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      readiness text DEFAULT 'draft' NOT NULL,
      metadata_json text DEFAULT '{}' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      UNIQUE(workspace_id, id)
    )
  `);
  await db.run(sql`
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      builtin_key text,
      name text NOT NULL,
      description text NOT NULL,
      category text NOT NULL,
      system_prompt text NOT NULL,
      variable_schema_json text NOT NULL,
      is_default integer DEFAULT false NOT NULL,
      is_active integer DEFAULT true NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      UNIQUE(workspace_id, id),
      UNIQUE(workspace_id, builtin_key)
    )
  `);
  await db.run(sql`
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
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
      updated_at integer NOT NULL,
      UNIQUE(workspace_id, id, document_id),
      FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (prompt_template_id) REFERENCES prompt_templates(id) ON DELETE SET NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
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
      FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, ai_run_id, document_id)
        REFERENCES ai_runs(workspace_id, id, document_id) ON DELETE CASCADE,
      CONSTRAINT "no_bad_targets" CHECK(target_text <> 'bad')
    )
  `);
  await db.run(sql`
    CREATE TRIGGER ai_runs_prompt_template_workspace_insert
    BEFORE INSERT ON ai_runs
    FOR EACH ROW
    WHEN NEW.prompt_template_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM prompt_templates
        WHERE workspace_id = NEW.workspace_id AND id = NEW.prompt_template_id
      ) THEN RAISE(ABORT, 'ai_run prompt template workspace mismatch') END;
    END
  `);
  await db.run(sql`
    CREATE TRIGGER ai_runs_prompt_template_workspace_update
    BEFORE UPDATE OF workspace_id, prompt_template_id ON ai_runs
    FOR EACH ROW
    WHEN NEW.prompt_template_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM prompt_templates
        WHERE workspace_id = NEW.workspace_id AND id = NEW.prompt_template_id
      ) THEN RAISE(ABORT, 'ai_run prompt template workspace mismatch') END;
    END
  `);

  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(schema.documents).values({
    id: "doc_1",
    workspaceId: workspaceA.workspaceId,
    title: "Memo",
    contentJson: { type: "doc" },
    plainText: "Text",
    readiness: "draft",
    metadataJson: {},
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.documents).values({
    id: "doc_b",
    workspaceId: workspaceB.workspaceId,
    title: "Workspace B Memo",
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
    workspaceId: workspaceA.workspaceId,
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
  await db.insert(schema.promptTemplates).values({
    id: "tpl_b",
    workspaceId: workspaceB.workspaceId,
    name: "Workspace B Review",
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

    const run = await repository.createAiRun(workspaceA, {
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "selection_rewrite",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: { selectedTextLength: 4 },
    });
    const completedRun = await repository.completeAiRun(workspaceA, run.id, "New text");
    const failedRun = await repository.failAiRun(workspaceA, run.id, "late failure");
    const runs = await repository.listAiRunsForDocument(workspaceA, "doc_1");

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
    const run = await repository.createAiRun(workspaceA, {
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: { documentTextLength: 4 },
    });

    await expect(
      repository.completeAiRunWithProposals(workspaceA, run.id, "review output", [
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

  it("does not list or finalize AI runs across workspaces", async () => {
    const db = await createIsolatedAiRunDb();
    const repository = createAiRunRepository(db);
    const run = await repository.createAiRun(workspaceA, {
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: { documentTextLength: 4 },
    });

    await expect(repository.listAiRunsForDocument(workspaceB, "doc_1")).resolves.toEqual([]);
    await expect(repository.completeAiRun(workspaceB, run.id, "Hijacked")).resolves.toBeNull();
    await expect(repository.failAiRun(workspaceB, run.id, "Hijacked")).resolves.toBeNull();
    await expect(
      repository.completeAiRunWithProposals(workspaceB, run.id, "Hijacked", []),
    ).resolves.toBeNull();

    await expect(repository.listAiRunsForDocument(workspaceA, "doc_1")).resolves.toEqual([
      expect.objectContaining({ id: run.id, outputText: "", status: "pending", workspaceId: workspaceA.workspaceId }),
    ]);
  });

  it("rejects AI runs that reference another workspace's document or template", async () => {
    const db = await createIsolatedAiRunDb();
    const repository = createAiRunRepository(db);

    await expect(
      repository.createAiRun(workspaceB, {
        documentId: "doc_b",
        promptTemplateId: "tpl_1",
        commandType: "document_review",
        provider: "stub",
        model: "stub-editor",
        inputSummaryJson: {},
      }),
    ).rejects.toThrow();
    await expect(
      repository.createAiRun(workspaceB, {
        documentId: "doc_1",
        promptTemplateId: null,
        commandType: "document_review",
        provider: "stub",
        model: "stub-editor",
        inputSummaryJson: {},
      }),
    ).rejects.toThrow();

    await expect(
      repository.createAiRun(workspaceA, {
        documentId: "doc_1",
        promptTemplateId: "tpl_1",
        commandType: "document_review",
        provider: "stub",
        model: "stub-editor",
        inputSummaryJson: {},
      }),
    ).resolves.toMatchObject({ workspaceId: workspaceA.workspaceId });

    const [savedRun] = await repository.listAiRunsForDocument(workspaceA, "doc_1");
    expect(savedRun).toBeDefined();
    await expect(
      db
        .update(schema.aiRuns)
        .set({ promptTemplateId: "tpl_b" })
        .where(sql`${schema.aiRuns.id} = ${savedRun!.id}`),
    ).rejects.toThrow();
  });

  it("sets deleted templates to null and cascades document deletion through runs and proposals", async () => {
    const db = await createIsolatedAiRunDb();
    const repository = createAiRunRepository(db);
    const run = await repository.createAiRun(workspaceA, {
      documentId: "doc_1",
      promptTemplateId: "tpl_1",
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: {},
    });
    await repository.completeAiRunWithProposals(workspaceA, run.id, "review", [
      {
        documentId: "doc_1",
        targetText: "Text",
        replacementText: "Improved text",
        explanation: "Clearer.",
      },
    ]);

    await db.delete(schema.promptTemplates).where(sql`${schema.promptTemplates.id} = 'tpl_1'`);
    const [runWithoutTemplate] = await db.select().from(schema.aiRuns).where(sql`${schema.aiRuns.id} = ${run.id}`);
    expect(runWithoutTemplate?.promptTemplateId).toBeNull();

    await db.delete(schema.documents).where(sql`${schema.documents.id} = 'doc_1'`);
    await expect(db.select().from(schema.aiRuns)).resolves.toEqual([]);
    await expect(db.select().from(schema.aiProposals)).resolves.toEqual([]);
  });
});
