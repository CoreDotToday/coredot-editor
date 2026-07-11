import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimLocalWorkspace } from "./claim-local-workspace";

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createClaimDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-claim-workspace-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "claim.db")}` });
  clients.push(client);
  await client.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL,
      UNIQUE(workspace_id, id)
    );
    CREATE TABLE prompt_templates (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, builtin_key text,
      UNIQUE(workspace_id, id), UNIQUE(workspace_id, builtin_key)
    );
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, document_id text NOT NULL,
      prompt_template_id text,
      UNIQUE(workspace_id, id, document_id),
      FOREIGN KEY(workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, ai_run_id text NOT NULL,
      document_id text NOT NULL,
      FOREIGN KEY(workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, ai_run_id, document_id)
        REFERENCES ai_runs(workspace_id, id, document_id) ON DELETE CASCADE
    );
    CREATE TABLE app_settings (
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL UNIQUE
    );
    CREATE TRIGGER ai_runs_prompt_template_workspace_update
    BEFORE UPDATE OF workspace_id, prompt_template_id ON ai_runs
    FOR EACH ROW WHEN NEW.prompt_template_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM prompt_templates
        WHERE workspace_id = NEW.workspace_id AND id = NEW.prompt_template_id
      ) THEN RAISE(ABORT, 'ai_run prompt template workspace mismatch') END;
    END;
    INSERT INTO documents VALUES ('doc_local', 'local');
    INSERT INTO prompt_templates VALUES ('tpl_local', 'local', 'builtin-review');
    INSERT INTO ai_runs VALUES ('run_local', 'local', 'doc_local', 'tpl_local');
    INSERT INTO ai_proposals VALUES ('proposal_local', 'local', 'run_local', 'doc_local');
    INSERT INTO app_settings VALUES ('settings_local', 'local');
  `);
  return client;
}

describe("claimLocalWorkspace", () => {
  it("moves every legacy row atomically and leaves foreign keys clean", async () => {
    const client = await createClaimDatabase();

    const summary = await claimLocalWorkspace(client, " workspace-acme ");

    expect(summary).toEqual({
      aiProposals: 1,
      aiRuns: 1,
      appSettings: 1,
      documents: 1,
      promptTemplates: 1,
      targetWorkspaceId: "workspace-acme",
    });
    for (const table of ["documents", "prompt_templates", "ai_runs", "ai_proposals", "app_settings"]) {
      expect((await client.execute(`SELECT workspace_id FROM ${table}`)).rows).toEqual([
        expect.objectContaining({ workspace_id: "workspace-acme" }),
      ]);
    }
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("is a no-op when there are no local rows", async () => {
    const client = await createClaimDatabase();
    await claimLocalWorkspace(client, "workspace-acme");

    await expect(claimLocalWorkspace(client, "workspace-other")).resolves.toMatchObject({
      aiProposals: 0,
      aiRuns: 0,
      appSettings: 0,
      documents: 0,
      promptTemplates: 0,
    });
  });

  it.each(["", "   ", "local", " local "])("rejects invalid target %j", async (target) => {
    const client = await createClaimDatabase();
    await expect(claimLocalWorkspace(client, target)).rejects.toThrow(/non-empty|reserved/i);
    expect((await client.execute("SELECT DISTINCT workspace_id FROM documents")).rows[0]?.workspace_id).toBe("local");
  });

  it("rolls back without partial movement when target builtins conflict", async () => {
    const client = await createClaimDatabase();
    await client.execute("INSERT INTO prompt_templates VALUES ('target_tpl', 'workspace-acme', 'builtin-review')");

    await expect(claimLocalWorkspace(client, "workspace-acme")).rejects.toThrow(/builtin-review.*conflict/i);

    expect((await client.execute("SELECT workspace_id FROM documents WHERE id='doc_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("SELECT workspace_id FROM ai_runs WHERE id='run_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("rolls back when the target already has settings", async () => {
    const client = await createClaimDatabase();
    await client.execute("INSERT INTO app_settings VALUES ('target_settings', 'workspace-acme')");

    await expect(claimLocalWorkspace(client, "workspace-acme")).rejects.toThrow(/settings.*conflict/i);
    expect((await client.execute("SELECT workspace_id FROM app_settings WHERE id='settings_local'")).rows[0]?.workspace_id).toBe("local");
    expect((await client.execute("SELECT workspace_id FROM documents WHERE id='doc_local'")).rows[0]?.workspace_id).toBe("local");
  });

  it("supports a dry run that reports counts without mutation", async () => {
    const client = await createClaimDatabase();
    const summary = await claimLocalWorkspace(client, "workspace-acme", { dryRun: true });

    expect(summary.documents).toBe(1);
    expect((await client.execute("SELECT workspace_id FROM documents")).rows[0]?.workspace_id).toBe("local");
  });
});
