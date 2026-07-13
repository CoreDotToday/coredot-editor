import { createClient, type Client } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { aiProposals, documents, type TiptapJson } from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createDocumentChangeService } from "@/features/documents/document-change-service";
import { createDocumentRepository } from "@/features/documents/document-repository";

const clients: Client[] = [];
const tempDirs: string[] = [];
const scope: RequestContext = {
  authMode: "test",
  principalId: "concurrency_principal",
  requestId: "concurrency_request",
  role: "owner",
  workspaceId: "local",
};
const createdAt = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function content(text: string): TiptapJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function draft(text: string) {
  return { title: "Concurrent draft", contentJson: content(text), metadataJson: {}, readiness: "draft" as const };
}

async function createConcurrencyDatabase(options: { wal?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "coredot-proposal-concurrency-"));
  tempDirs.push(dir);
  const path = join(dir, "concurrency.db");
  const setupClient = await createTrackedClient(path);
  const setupDb = drizzle(setupClient, { schema });
  if (options.wal) {
    await setupClient.execute("PRAGMA journal_mode = WAL");
  }

  await setupClient.executeMultiple(`
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
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX documents_workspace_id_id_unique ON documents(workspace_id, id);
    CREATE UNIQUE INDEX documents_workspace_creation_key_unique ON documents(workspace_id, creation_key);
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
    );
    CREATE UNIQUE INDEX ai_proposals_workspace_id_id_document_id_unique
      ON ai_proposals(workspace_id, id, document_id);
    CREATE TABLE document_changes (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      principal_id text NOT NULL,
      request_id text NOT NULL,
      kind text NOT NULL,
      batch_id text,
      before_snapshot_json text NOT NULL,
      after_revision integer NOT NULL,
      created_at integer NOT NULL,
      undone_at integer
    );
    CREATE UNIQUE INDEX document_changes_workspace_id_document_unique
      ON document_changes(workspace_id, id, document_id);
    CREATE TABLE document_change_proposals (
      workspace_id text NOT NULL,
      change_id text NOT NULL,
      document_id text NOT NULL,
      proposal_id text NOT NULL,
      applied_mode text NOT NULL,
      ordinal integer NOT NULL,
      PRIMARY KEY(workspace_id, change_id, proposal_id)
    );
    CREATE UNIQUE INDEX document_change_proposals_workspace_change_ordinal_unique
      ON document_change_proposals(workspace_id, change_id, ordinal);
  `);

  return {
    createDb: async () => drizzle(await createTrackedClient(path), { schema }),
    path,
    setupDb,
  };
}

async function createTrackedClient(path: string) {
  const client = createClient({ url: `file:${path}` });
  clients.push(client);
  await client.execute("PRAGMA busy_timeout = 0");
  return client;
}

async function seedDocument(
  db: Awaited<ReturnType<typeof createConcurrencyDatabase>>["setupDb"],
  id: string,
  text: string,
) {
  await db.insert(documents).values({
    id,
    workspaceId: scope.workspaceId,
    title: id,
    contentJson: content(text),
    metadataJson: {},
    plainText: text,
    readiness: "draft",
    status: "draft",
    createdAt,
    updatedAt: createdAt,
  });
}

async function seedProposal(
  db: Awaited<ReturnType<typeof createConcurrencyDatabase>>["setupDb"],
  input: {
    documentId: string;
    id: string;
    replacementText: string;
    targetText: string;
  },
) {
  await db.insert(aiProposals).values({
    id: input.id,
    workspaceId: scope.workspaceId,
    aiRunId: `run_${input.id}`,
    documentId: input.documentId,
    targetText: input.targetText,
    replacementText: input.replacementText,
    explanation: "Concurrency test",
    source: "review",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  });
}

async function settleBehindWriteLock<T>(path: string, operations: Array<() => Promise<T>>) {
  const worker = new Worker(
    `
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");
    const database = new DatabaseSync(workerData.path);
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.postMessage("released");
    }, 20);
  `,
    { eval: true, workerData: { path } },
  );
  const locked = waitForWorkerMessage(worker, "locked");
  const released = waitForWorkerMessage(worker, "released");
  await locked;
  const pending = operations.map((operation) => operation());
  const settled = Promise.allSettled(pending);
  await released;
  await worker.terminate();
  return settled;
}

function waitForWorkerMessage(worker: Worker, expectedMessage: string) {
  return new Promise<void>((resolve, reject) => {
    const handleMessage = (message: unknown) => {
      if (message !== expectedMessage) return;
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", handleMessage);
      worker.off("error", handleError);
    };
    worker.on("message", handleMessage);
    worker.on("error", handleError);
  });
}

function settledStatuses(settled: PromiseSettledResult<unknown>[]) {
  return settled.map((result) => {
    if (result.status === "fulfilled") return "fulfilled";
    const reason = result.reason as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    const location = String(reason?.stack ?? "")
      .split("\n")
      .slice(1, 8)
      .join(" | ");
    return `${String(reason?.code ?? "unknown")}: ${String(reason?.message ?? reason)} cause=${formatErrorChain(
      reason?.cause,
    )} ${location}`.trim();
  });
}

function formatErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    parts.push(`${String(value.code ?? "unknown")}:${String(value.message ?? current)}`);
    current = value.cause;
  }
  return parts.join(" -> ");
}

describe("proposal and document concurrency", () => {
  it("retries a document save after an external write lock is released", async () => {
    const { createDb, path, setupDb } = await createConcurrencyDatabase();
    await seedDocument(setupDb, "locked_save_doc", "original");
    const repository = createDocumentRepository(await createDb());

    const settled = await settleBehindWriteLock(path, [
      () =>
        repository.saveDocumentDraft(scope, "locked_save_doc", {
          title: "Saved",
          contentJson: content("saved"),
          expectedRevision: 0,
        }),
    ]);

    expect(settledStatuses(settled)).toEqual(["fulfilled"]);
    expect(settled[0]).toMatchObject({
      status: "fulfilled",
      value: { status: "success" },
    });
  });

  it("retries a proposal transaction after an external write lock is released", async () => {
    const { createDb, path, setupDb } = await createConcurrencyDatabase();
    await seedDocument(setupDb, "locked_doc", "growth was good");
    await seedProposal(setupDb, {
      documentId: "locked_doc",
      id: "locked_proposal",
      replacementText: "revenue grew 8%",
      targetText: "growth was good",
    });
    const service = createDocumentChangeService(await createDb());

    const settled = await settleBehindWriteLock(path, [
      () =>
        service.applyProposal(scope, {
          documentId: "locked_doc",
          draft: draft("growth was good"),
          expectedRevision: 0,
          mode: "replace",
          proposalId: "locked_proposal",
        }),
    ]);

    expect(settledStatuses(settled)).toEqual(["fulfilled"]);
  });

  it("settles concurrent proposal application and document save without leaking SQLite contention", async () => {
    const { createDb, setupDb } = await createConcurrencyDatabase({
      wal: true,
    });
    const repository = createDocumentRepository(await createDb());
    const service = createDocumentChangeService(await createDb());

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const documentId = `save_doc_${String(iteration)}`;
      const proposalId = `save_proposal_${String(iteration)}`;
      await seedDocument(setupDb, documentId, "growth was good");
      await seedProposal(setupDb, {
        documentId,
        id: proposalId,
        replacementText: "revenue grew 8%",
        targetText: "growth was good",
      });
      const settled = await Promise.allSettled([
        repository.saveDocumentDraft(scope, documentId, {
          title: "Manual save",
          contentJson: content("manual edit"),
          expectedRevision: 0,
        }),
        service.applyProposal(scope, {
          documentId,
          draft: draft("growth was good"),
          expectedRevision: 0,
          mode: "replace",
          proposalId,
        }),
      ] as const);

      expect(settledStatuses(settled)).toEqual(["fulfilled", "fulfilled"]);
      if (settled[0]?.status !== "fulfilled" || settled[1]?.status !== "fulfilled") continue;
      const saveResult = settled[0].value;
      const proposalResult = settled[1].value;
      expect(
        (saveResult.status === "success" && !proposalResult.ok && proposalResult.reason === "revision_conflict") ||
          (saveResult.status === "revision_conflict" && proposalResult.ok),
      ).toBe(true);
      const [savedDocument] = await setupDb.select().from(documents).where(eq(documents.id, documentId));
      expect(savedDocument?.revision).toBe(1);
      expect(["manual edit", "revenue grew 8%"]).toContain(savedDocument?.plainText);
    }
  });

  it("settles concurrent applications of the same pending proposal with one stable status conflict", async () => {
    const { createDb, setupDb } = await createConcurrencyDatabase({
      wal: true,
    });
    const first = createDocumentChangeService(await createDb());
    const second = createDocumentChangeService(await createDb());

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const documentId = `same_doc_${String(iteration)}`;
      const proposalId = `same_proposal_${String(iteration)}`;
      await seedDocument(setupDb, documentId, "growth was good");
      await seedProposal(setupDb, {
        documentId,
        id: proposalId,
        replacementText: "revenue grew 8%",
        targetText: "growth was good",
      });
      const input = {
        documentId,
        draft: draft("growth was good"),
        expectedRevision: 0,
        mode: "replace" as const,
        proposalId,
      };
      const settled = await Promise.allSettled([
        first.applyProposal(scope, input),
        second.applyProposal(scope, input),
      ] as const);

      expect(settledStatuses(settled)).toEqual(["fulfilled", "fulfilled"]);
      const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === "status_conflict")).toHaveLength(1);
    }
  });

  it("settles different pending proposals with one document change conflict and atomic status", async () => {
    const { createDb, setupDb } = await createConcurrencyDatabase({
      wal: true,
    });
    const first = createDocumentChangeService(await createDb());
    const second = createDocumentChangeService(await createDb());

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const documentId = `different_doc_${String(iteration)}`;
      const firstProposalId = `alpha_proposal_${String(iteration)}`;
      const secondProposalId = `beta_proposal_${String(iteration)}`;
      await seedDocument(setupDb, documentId, "alpha beta");
      await seedProposal(setupDb, {
        documentId,
        id: firstProposalId,
        replacementText: "A",
        targetText: "alpha",
      });
      await seedProposal(setupDb, {
        documentId,
        id: secondProposalId,
        replacementText: "B",
        targetText: "beta",
      });
      const settled = await Promise.allSettled([
        first.applyProposal(scope, {
          documentId,
          draft: draft("alpha beta"),
          expectedRevision: 0,
          mode: "replace",
          proposalId: firstProposalId,
        }),
        second.applyProposal(scope, {
          documentId,
          draft: draft("alpha beta"),
          expectedRevision: 0,
          mode: "replace",
          proposalId: secondProposalId,
        }),
      ] as const);

      expect(settledStatuses(settled)).toEqual(["fulfilled", "fulfilled"]);
      const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === "revision_conflict")).toHaveLength(1);
      const statuses = await setupDb
        .select({ status: aiProposals.status })
        .from(aiProposals)
        .where(sql`${aiProposals.id} in (${firstProposalId}, ${secondProposalId})`);
      expect(statuses.filter(({ status }) => status === "accepted")).toHaveLength(1);
      expect(statuses.filter(({ status }) => status === "pending")).toHaveLength(1);
    }
  });
});
