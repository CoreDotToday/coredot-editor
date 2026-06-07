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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedProposalDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-proposal-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "proposals.db")}` });
  const db = drizzle(client, { schema });

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
      updated_at integer NOT NULL
    )
  `);

  return db;
}

describe("proposal repository", () => {
  it("creates pending proposals for an AI run", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);

    const proposal = await repository.createProposal({
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
    });
  });

  it("lists proposals for a document and updates proposal status", async () => {
    const db = await createIsolatedProposalDb();
    const repository = createProposalRepository(db);
    const firstProposal = await repository.createProposal({
      aiRunId: "run_1",
      documentId: "doc_1",
      targetText: "first",
      replacementText: "updated first",
      explanation: "First.",
    });
    await repository.createProposal({
      aiRunId: "run_1",
      documentId: "doc_2",
      targetText: "other",
      replacementText: "updated other",
      explanation: "Other.",
    });

    const updatedProposal = await repository.updateProposalStatus(firstProposal.id, "accepted", "insert_below");
    const proposals = await repository.listProposalsForDocument("doc_1");

    expect(updatedProposal?.status).toBe("accepted");
    expect(updatedProposal?.appliedMode).toBe("insert_below");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: firstProposal.id, appliedMode: "insert_below", status: "accepted" });
  });
});
