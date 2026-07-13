import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createProposalRepository } from "./proposal-repository";

const tempDirs: string[] = [];
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedProposalDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-proposal-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "proposals.db")}` });
  const db = drizzle(client, { schema });
  await db.run(sql`PRAGMA foreign_keys = ON`);

  await db.run(sql`
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      creation_key text,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      readiness text DEFAULT 'draft' NOT NULL,
      metadata_json text DEFAULT '{}' NOT NULL,
      revision integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      UNIQUE(workspace_id, id),
      UNIQUE(workspace_id, creation_key)
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
      FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
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
        REFERENCES ai_runs(workspace_id, id, document_id) ON DELETE CASCADE
    )
  `);

  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(schema.documents).values([
    {
      id: "doc_1",
      workspaceId: workspaceA.workspaceId,
      title: "First",
      contentJson: { type: "doc" },
      plainText: "First",
      readiness: "draft",
      metadataJson: {},
      status: "draft",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "doc_2",
      workspaceId: workspaceA.workspaceId,
      title: "Second",
      contentJson: { type: "doc" },
      plainText: "Second",
      readiness: "draft",
      metadataJson: {},
      status: "draft",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.aiRuns).values([
    {
      id: "run_1",
      workspaceId: workspaceA.workspaceId,
      documentId: "doc_1",
      promptTemplateId: null,
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: {},
      outputText: "",
      status: "completed",
      wasApplied: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "run_2",
      workspaceId: workspaceA.workspaceId,
      documentId: "doc_2",
      promptTemplateId: null,
      commandType: "document_review",
      provider: "stub",
      model: "stub-editor",
      inputSummaryJson: {},
      outputText: "",
      status: "completed",
      wasApplied: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return db;
}

describe("proposal repository", () => {
  it("creates pending proposals for an AI run", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);

    const proposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer phrasing.",
      source: "selection",
      command: "Improve clarity",
      occurrenceIndex: 1,
      targetFrom: 8,
      targetTo: 16,
      defaultApplyMode: "replace",
    });

    expect(proposal).toMatchObject({
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer phrasing.",
      source: "selection",
      command: "Improve clarity",
      occurrenceIndex: 1,
      targetFrom: 8,
      targetTo: 16,
      defaultApplyMode: "replace",
      status: "pending",
      workspaceId: workspaceA.workspaceId,
    });
  });

  it("lists proposals for a document and rejects a pending proposal", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const firstProposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "first",
      replacementText: "updated first",
      explanation: "First.",
    });
    await repository.createProposal(workspaceA, {
      aiRunId: "run_2",
      documentId: "doc_2",
      targetText: "other",
      replacementText: "updated other",
      explanation: "Other.",
    });

    const updatedProposal = await repository.updateProposalStatus(
      workspaceA,
      firstProposal.id,
      "rejected",
    );
    const proposals = await repository.listProposalsForDocument(workspaceA, "doc_1");

    expect(updatedProposal?.status).toBe("rejected");
    expect(updatedProposal?.appliedMode).toBeNull();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: firstProposal.id, appliedMode: null, status: "rejected" });
  });

  it("does not let generic repository callers bypass transactional proposal acceptance", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const proposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer.",
    });

    const updatedProposal = await repository.updateProposalStatus(
      workspaceA,
      proposal.id,
      "accepted",
      "replace",
      { expectedStatus: "pending" },
    );

    expect(updatedProposal).toBeNull();
    await expect(repository.getProposalById(workspaceA, proposal.id)).resolves.toMatchObject({
      appliedMode: null,
      status: "pending",
    });
  });

  it.each(["pending", "rejected"] as const)(
    "does not transition an accepted proposal to %s outside transactional undo",
    async (status) => {
      const db = await createIsolatedProposalDb();
      const repository = createProposalRepository(db);
      const proposal = await repository.createProposal(workspaceA, {
        aiRunId: "run_1",
        documentId: "doc_1",
        targetText: "old",
        replacementText: "new",
        explanation: "Clearer.",
      });
      await db.update(schema.aiProposals).set({ appliedMode: "replace", status: "accepted" });

      const updatedProposal = await repository.updateProposalStatus(
        workspaceA,
        proposal.id,
        status,
        undefined,
        { expectedStatus: "accepted" },
      );

      expect(updatedProposal).toBeNull();
      await expect(repository.getProposalById(workspaceA, proposal.id)).resolves.toMatchObject({
        appliedMode: "replace",
        status: "accepted",
      });
    },
  );

  it("allows a rejected proposal to return to pending", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const proposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer.",
    });
    await repository.updateProposalStatus(workspaceA, proposal.id, "rejected", undefined, {
      expectedStatus: "pending",
    });

    const restoredProposal = await repository.updateProposalStatus(
      workspaceA,
      proposal.id,
      "pending",
      undefined,
      { expectedStatus: "rejected" },
    );

    expect(restoredProposal).toMatchObject({ appliedMode: null, status: "pending" });
  });

  it("does not update a proposal when the expected status is stale", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const proposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Clearer.",
    });

    const updatedProposal = await repository.updateProposalStatus(workspaceA, proposal.id, "accepted", "replace", {
      expectedStatus: "accepted",
    });
    const savedProposal = await repository.getProposalById(workspaceA, proposal.id);

    expect(updatedProposal).toBeNull();
    expect(savedProposal).toMatchObject({ id: proposal.id, appliedMode: null, status: "pending" });
  });

  it("does not reveal or update proposals across workspaces", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const proposal = await repository.createProposal(workspaceA, {
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "old",
      replacementText: "new",
      explanation: "Private proposal.",
    });

    await expect(repository.getProposalById(workspaceB, proposal.id)).resolves.toBeNull();
    await expect(repository.listProposalsForDocument(workspaceB, "doc_1")).resolves.toEqual([]);
    await expect(
      repository.updateProposalStatus(workspaceB, proposal.id, "accepted", "replace"),
    ).resolves.toBeNull();

    await expect(repository.getProposalById(workspaceA, proposal.id)).resolves.toMatchObject({
      status: "pending",
      workspaceId: workspaceA.workspaceId,
    });
  });

  it("rejects proposals that reference another workspace or a different run document", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);

    await expect(
      repository.createProposal(workspaceB, {
        aiRunId: "run_1",
        documentId: "doc_1",
        targetText: "old",
        replacementText: "new",
        explanation: "Cross-workspace.",
      }),
    ).rejects.toThrow();
    await expect(
      repository.createProposal(workspaceA, {
        aiRunId: "run_1",
        documentId: "doc_2",
        targetText: "old",
        replacementText: "new",
        explanation: "Wrong document.",
      }),
    ).rejects.toThrow();
    await expect(
      repository.createProposal(workspaceA, {
        aiRunId: "run_1",
        documentId: "doc_1",
        targetText: "old",
        replacementText: "new",
        explanation: "Same workspace and document.",
      }),
    ).resolves.toMatchObject({ workspaceId: workspaceA.workspaceId });
  });
});
