import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { defaultPromptTemplates } from "@/db/seed";
import { createWorkspaceBootstrap } from "./workspace-bootstrap";
import { createProtectedRouteHandler } from "@/features/auth/route-context";
import type { RequestContext } from "@/features/auth/request-context";
import { enforceRequestBudget, setRequestBudgetForTests } from "@/features/security/request-budget";

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
      UNIQUE(workspace_id, builtin_key)
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
  it("does not create templates or settings when an authenticated request exhausts its pre-bootstrap budget", async () => {
    const db = await createIsolatedWorkspaceDb();
    const ensureWorkspaceBootstrap = createWorkspaceBootstrap(db);
    const context: RequestContext = {
      authMode: "test",
      principalId: "new-principal",
      requestId: "limited-request",
      role: "owner",
      workspaceId: "limited-new-workspace",
    };
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAt: new Date(Date.now() + 60_000),
      })),
    });
    const parseBody = vi.fn();
    const handler = createProtectedRouteHandler(
      async (_requestContext: RequestContext, _request: Request) => {
        void _requestContext;
        void _request;
        await parseBody();
        return Response.json({ ok: true });
      },
      { beforeWorkspaceBootstrap: (requestContext) => enforceRequestBudget(requestContext, "documents.create") },
      { ensureWorkspaceBootstrap, getRequestContext: async () => context },
    );

    const response = await handler(new Request("http://localhost/api/documents", { method: "POST" }));

    expect(response.status).toBe(429);
    expect(parseBody).not.toHaveBeenCalled();
    expect(await db.select().from(schema.promptTemplates)).toEqual([]);
    expect(await db.select().from(schema.appSettings)).toEqual([]);
  });

  it("bootstraps a new workspace once through concurrent first protected requests", async () => {
    const db = await createIsolatedWorkspaceDb();
    const ensureWorkspaceBootstrap = createWorkspaceBootstrap(db);
    const context: RequestContext = {
      authMode: "test",
      principalId: "new-principal",
      requestId: "new-request",
      role: "owner",
      workspaceId: "new-workspace",
    };
    const handler = createProtectedRouteHandler(
      async (requestContext, request: Request) => {
        void request;
        return Response.json({ workspaceId: requestContext.workspaceId });
      },
      {
        ensureWorkspaceBootstrap,
        getRequestContext: async () => context,
      },
    );

    const responses = await Promise.all([
      handler(new Request("http://localhost/api/documents")),
      handler(new Request("http://localhost/api/templates")),
      handler(new Request("http://localhost/api/settings/ai")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const templates = await db.select().from(schema.promptTemplates);
    const settings = await db.select().from(schema.appSettings);
    expect(templates).toHaveLength(defaultPromptTemplates.length);
    expect(templates.every((template) => template.workspaceId === context.workspaceId)).toBe(true);
    expect(settings).toHaveLength(1);
    expect(settings[0]?.workspaceId).toBe(context.workspaceId);
  });

  it("creates defaults idempotently for each workspace without copying another workspace's values", async () => {
    const db = await createIsolatedWorkspaceDb();
    const ensureWorkspaceBootstrap = createWorkspaceBootstrap(db);

    await db.insert(schema.promptTemplates).values({
      id: "tpl_strategy_review",
      workspaceId: workspaceA.workspaceId,
      builtinKey: "tpl_strategy_review",
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

  it("keeps multiple built-ins in the same category unique and safe under concurrent bootstrap", async () => {
    const db = await createIsolatedWorkspaceDb();
    const sameCategoryBuiltins = [
      {
        ...defaultPromptTemplates[0]!,
        id: "tpl_shared_category_one",
        category: "shared_category",
        name: "Shared Category One",
      },
      {
        ...defaultPromptTemplates[1]!,
        id: "tpl_shared_category_two",
        category: "shared_category",
        name: "Shared Category Two",
      },
    ];
    const ensureWorkspaceBootstrap = createWorkspaceBootstrap(db, sameCategoryBuiltins);

    await Promise.all([
      ensureWorkspaceBootstrap(workspaceA),
      ensureWorkspaceBootstrap(workspaceA),
      ensureWorkspaceBootstrap(workspaceA),
    ]);
    await ensureWorkspaceBootstrap(workspaceA);

    const rows = await db.all<{ builtin_key: string | null; category: string }>(sql`
      SELECT builtin_key, category
      FROM prompt_templates
      WHERE workspace_id = ${workspaceA.workspaceId}
      ORDER BY builtin_key
    `);
    expect(rows).toEqual([
      { builtin_key: "tpl_shared_category_one", category: "shared_category" },
      { builtin_key: "tpl_shared_category_two", category: "shared_category" },
    ]);
  });
});
