import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { aiProposals, documents, type TiptapJson } from "@/db/schema";
import { createProposalApplicationService } from "./proposal-application-service";
import { createProposalContentSignature } from "./proposal-transaction";

const tempDirs: string[] = [];
const localScope = { workspaceId: "local" };
const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createIsolatedProposalApplicationDb() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-proposal-application-test-"));
  tempDirs.push(dir);

  const client = createClient({ url: `file:${join(dir, "proposal-application.db")}` });
  const db = drizzle(client, { schema });

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
      revision integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
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
      updated_at integer NOT NULL
    )
  `);

  return db;
}

const createdAt = new Date("2026-01-01T00:00:00.000Z");

function createDocumentContent(text: string): TiptapJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function seedDocumentAndProposal(
  db: Awaited<ReturnType<typeof createIsolatedProposalApplicationDb>>,
  input: {
    documentContent?: TiptapJson;
    documentStatus?: "draft" | "archived";
    proposalStatus?: "pending" | "accepted" | "rejected";
    targetFrom?: number | null;
    targetTo?: number | null;
    targetText?: string;
    workspaceId?: string;
  } = {},
) {
  const documentContent = input.documentContent ?? createDocumentContent("growth was good");
  const workspaceId = input.workspaceId ?? localScope.workspaceId;
  await db.insert(documents).values({
    id: "doc_1",
    workspaceId,
    title: "Market Entry Memo",
    contentJson: documentContent,
    metadataJson: { owner: "Strategy" },
    plainText: "growth was good",
    readiness: "draft",
    status: input.documentStatus ?? "draft",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(aiProposals).values({
    id: "proposal_1",
    workspaceId,
    aiRunId: "run_1",
    documentId: "doc_1",
    targetText: input.targetText ?? "growth was good",
    replacementText: "revenue grew 8%",
    explanation: "Specificity helps review.",
    source: "review",
    targetFrom: input.targetFrom,
    targetTo: input.targetTo,
    status: input.proposalStatus ?? "pending",
    createdAt,
    updatedAt: createdAt,
  });
}

describe("proposal application service", () => {
  it("applies a proposal to the saved server document and persists accepted proposal status", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db);
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(localScope, {
      appliedMode: "replace",
      draft: {
        id: "doc_1",
      },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("growth was good")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.proposal).toMatchObject({ appliedMode: "replace", id: "proposal_1", status: "accepted" });
    expect(result.document).toMatchObject({
      id: "doc_1",
      metadataJson: { owner: "Strategy" },
      plainText: "revenue grew 8%",
      readiness: "draft",
      revision: 1,
      title: "Market Entry Memo",
    });
    expect(result.document.contentJson).toEqual(createDocumentContent("revenue grew 8%"));
    const [savedProposal] = await db.select().from(aiProposals).where(eq(aiProposals.id, "proposal_1"));
    const [savedDocument] = await db.select().from(documents).where(eq(documents.id, "doc_1"));
    expect(savedProposal).toMatchObject({ appliedMode: "replace", status: "accepted" });
    expect(savedDocument).toMatchObject({ plainText: "revenue grew 8%", revision: 1 });
  });

  it("returns a proposal conflict without changing the document when the expected status is stale", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db, { proposalStatus: "rejected" });
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(localScope, {
      appliedMode: "replace",
      draft: {
        id: "doc_1",
      },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("growth was good")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });
    const [document] = await db.select().from(documents).where(sql`${documents.id} = 'doc_1'`);

    expect(result).toMatchObject({
      error: "proposal_status_changed",
      ok: false,
      proposal: { id: "proposal_1", status: "rejected" },
    });
    expect(document).toMatchObject({
      plainText: "growth was good",
      revision: 0,
      title: "Market Entry Memo",
    });
  });

  it("does not persist document or proposal changes when the submitted draft no longer matches the proposal range", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db, {
      documentContent: createDocumentContent("Edited text"),
      targetFrom: 1,
      targetText: "Target text",
      targetTo: 12,
    });
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(localScope, {
      appliedMode: "replace",
      draft: {
        id: "doc_1",
      },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("Edited text")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });
    const [proposal] = await db.select().from(aiProposals).where(sql`${aiProposals.id} = 'proposal_1'`);
    const [document] = await db.select().from(documents).where(sql`${documents.id} = 'doc_1'`);

    expect(result).toMatchObject({
      applyFailureReason: "stale_selection",
      error: "proposal_apply_failed",
      ok: false,
      proposal: { id: "proposal_1", status: "pending" },
    });
    expect(proposal).toMatchObject({ appliedMode: null, status: "pending" });
    expect(document).toMatchObject({ plainText: "growth was good", revision: 0, title: "Market Entry Memo" });
  });

  it("does not accept a proposal when its document is no longer active", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db, { documentStatus: "archived" });
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(localScope, {
      appliedMode: "replace",
      draft: {
        id: "doc_1",
      },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("growth was good")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });
    const [proposal] = await db.select().from(aiProposals).where(sql`${aiProposals.id} = 'proposal_1'`);

    expect(result).toMatchObject({
      error: "document_not_found",
      ok: false,
      proposal: { id: "proposal_1", status: "pending" },
    });
    expect(proposal).toMatchObject({ appliedMode: null, status: "pending" });
  });

  it("does not overwrite a newer saved document when the caller has a stale server content signature", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db, { documentContent: createDocumentContent("newer saved text") });
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(localScope, {
      appliedMode: "replace",
      draft: {
        id: "doc_1",
      },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("growth was good")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });
    const [proposal] = await db.select().from(aiProposals).where(sql`${aiProposals.id} = 'proposal_1'`);
    const [document] = await db.select().from(documents).where(sql`${documents.id} = 'doc_1'`);

    expect(result).toMatchObject({
      document: { id: "doc_1", contentJson: createDocumentContent("newer saved text") },
      error: "document_changed",
      ok: false,
      proposal: { id: "proposal_1", status: "pending" },
    });
    expect(proposal).toMatchObject({ appliedMode: null, status: "pending" });
    expect(document).toMatchObject({ plainText: "growth was good", title: "Market Entry Memo" });
  });

  it("does not reveal or mutate another workspace's proposal and document", async () => {
    const db = await createIsolatedProposalApplicationDb();
    await seedDocumentAndProposal(db, { workspaceId: workspaceA.workspaceId });
    const service = createProposalApplicationService(db);

    const result = await service.applyProposalToDocumentDraft(workspaceB, {
      appliedMode: "replace",
      draft: { id: "doc_1" },
      expectedDocumentContentSignature: createProposalContentSignature(createDocumentContent("growth was good")),
      expectedStatus: "pending",
      proposalId: "proposal_1",
    });
    const [proposal] = await db.select().from(aiProposals).where(eq(aiProposals.id, "proposal_1"));
    const [document] = await db.select().from(documents).where(eq(documents.id, "doc_1"));

    expect(result).toEqual({ error: "proposal_not_found", ok: false });
    expect(proposal).toMatchObject({ appliedMode: null, status: "pending", workspaceId: workspaceA.workspaceId });
    expect(document).toMatchObject({ plainText: "growth was good", workspaceId: workspaceA.workspaceId });
  });
});
