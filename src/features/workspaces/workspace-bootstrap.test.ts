import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createWorkspaceBootstrap } from "./workspace-bootstrap";

const tempDirs: string[] = [];
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedWorkspaceDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-workspace-bootstrap-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "workspace.db")}` });
  const db = drizzle(client, { schema });

  await db.run(sql`
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
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
    CREATE TABLE app_settings (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL UNIQUE,
      ai_provider text DEFAULT 'stub' NOT NULL,
      ai_model text DEFAULT 'stub-editor' NOT NULL,
      ai_base_url text,
      ai_max_completion_tokens integer,
      ai_reasoning_effort text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);

  return db;
}

describe("workspace bootstrap", () => {
  it("creates defaults idempotently for each workspace without copying another workspace's values", async () => {
    const db = await createIsolatedWorkspaceDb();
    const ensureWorkspaceBootstrap = createWorkspaceBootstrap(db);

    await db.insert(schema.promptTemplates).values({
      id: "legacy-local-strategy-template",
      workspaceId: workspaceA.workspaceId,
      name: "Legacy Strategy Review",
      description: "Migrated default",
      category: "strategy_review",
      systemPrompt: "Migrated prompt.",
      variableSchemaJson: { fields: [], required: [] },
      isDefault: true,
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await ensureWorkspaceBootstrap(workspaceA);
    await db
      .update(schema.appSettings)
      .set({ aiModel: "workspace-a-private-model", aiProvider: "openai" })
      .where(eq(schema.appSettings.workspaceId, workspaceA.workspaceId));
    await ensureWorkspaceBootstrap(workspaceA);
    await ensureWorkspaceBootstrap(workspaceB);

    const templates = await db.select().from(schema.promptTemplates);
    const settings = await db.select().from(schema.appSettings);
    const workspaceATemplates = templates.filter((template) => template.workspaceId === workspaceA.workspaceId);
    const workspaceBTemplates = templates.filter((template) => template.workspaceId === workspaceB.workspaceId);

    expect(workspaceATemplates).toHaveLength(4);
    expect(workspaceBTemplates).toHaveLength(4);
    expect(new Set(templates.map((template) => template.id)).size).toBe(8);
    expect(settings).toHaveLength(2);
    expect(settings.find((row) => row.workspaceId === workspaceA.workspaceId)).toMatchObject({
      aiModel: "workspace-a-private-model",
      aiProvider: "openai",
    });
    expect(settings.find((row) => row.workspaceId === workspaceB.workspaceId)).toMatchObject({
      aiModel: "stub-editor",
      aiProvider: "stub",
    });
  });
});
