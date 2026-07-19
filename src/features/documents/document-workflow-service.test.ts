// @vitest-environment node

import { createClient, type Client } from "@libsql/client";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import * as schema from "@/db/schema";
import {
  collaborationDocuments,
  collaborationWorkflowNotificationJobs,
  documentApprovals,
  documents,
} from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import {
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_NAME,
} from "@/features/collaboration/contracts";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { createCollaborationPersistence } from "@/features/collaboration/persistence";
import { defineProjectProfile } from "@/features/projects/project-profile";

import {
  DocumentWorkflowServiceError,
  createDocumentWorkflowService,
} from "./document-workflow-service";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const tempDirs: string[] = [];
const clients: Client[] = [];
const context: RequestContext = {
  authMode: "test",
  principalId: "principal-a",
  requestId: "request-a",
  role: "member",
  workspaceId: "workspace-a",
};

const profile = defineProjectProfile({
  defaultTemplateIds: [],
  id: "workflow-test",
  labels: { en: { name: "Workflow" }, ko: { name: "워크플로" } },
  metadataFields: [{
    id: "owner",
    labels: { en: "Owner", ko: "소유자" },
    required: true,
    type: "text",
  }],
  readiness: [
    { id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: ["needs_review"] },
    { id: "needs_review", labels: { en: "Review", ko: "검토" }, transitions: ["draft", "ready"] },
    { id: "ready", labels: { en: "Ready", ko: "준비" }, transitions: ["needs_review", "approved"] },
    { id: "approved", labels: { en: "Approved", ko: "승인" }, transitions: ["ready"] },
  ],
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("document workflow service", () => {
  it("keeps authorization behind an explicit service seam for every Workspace member role", async () => {
    const harness = await createHarness("authorization");
    const authorizeWorkflow = vi.fn(() => true);
    const service = harness.createService({ authorizeWorkflow });

    const result = await service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    });

    expect(result.workflow).toMatchObject({ readiness: "needs_review" });
    expect(authorizeWorkflow).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ id: harness.documentId, workspaceId: context.workspaceId }),
      { expectedReadiness: "draft", nextReadiness: "needs_review" },
    );
  });

  it("rejects a command when the resolved workflow authorization denies it", async () => {
    const harness = await createHarness("forbidden");
    const service = harness.createService({ authorizeWorkflow: () => false });

    await expect(service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).rejects.toMatchObject({ category: "forbidden" });

    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "draft", revision: 0 });
  });

  it("validates collaborative readiness against exact durable Yjs metadata instead of a stale SQL projection", async () => {
    const harness = await createHarness("exact-metadata");
    const snapshot = await harness.persistence.initialize(context, harness.documentId);
    const before = Y.encodeStateVector(snapshot.document);
    snapshot.document.getMap(COLLABORATION_METADATA_NAME).delete("owner");
    const update = Y.encodeStateAsUpdate(snapshot.document, before);
    snapshot.document.destroy();
    await harness.persistence.appendValidatedUpdate(context, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "remove-owner",
      originKind: "client",
      principalId: context.principalId,
      requestId: context.requestId,
      sessionId: "session-a",
      update,
    });
    expect((await harness.readDocument()).metadataJson).toEqual({ owner: "Ada" });

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).rejects.toMatchObject({
      category: "invalid_project_profile",
      violation: { fieldId: "owner", reason: "required" },
    });

    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "draft" });
  });

  it("approves atomically against the exact generation, head, state vector, and deterministic content hash", async () => {
    const harness = await createHarness("approve");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    const before = Y.encodeStateVector(initialized.document);
    initialized.document.getText(COLLABORATION_TITLE_NAME).insert(
      initialized.document.getText(COLLABORATION_TITLE_NAME).length,
      " current",
    );
    const update = Y.encodeStateAsUpdate(initialized.document, before);
    initialized.document.destroy();
    await harness.persistence.appendValidatedUpdate(context, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "title-current",
      originKind: "client",
      principalId: context.principalId,
      requestId: context.requestId,
      sessionId: "session-a",
      update,
    });
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));

    const result = await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 1,
    });

    expect(result.workflow).toMatchObject({
      collaboration: { generation: 1, headSeq: 1 },
      readiness: "approved",
      revision: 1,
    });
    const [approval] = await harness.database.select().from(documentApprovals);
    expect(approval).toMatchObject({
      approvedHeadSeq: 1,
      generation: 1,
      invalidatedAt: null,
      principalId: context.principalId,
      requestId: context.requestId,
    });
    expect(approval?.approvedStateVector.byteLength).toBeGreaterThan(0);
    expect(approval?.approvedContentHash).toMatch(/^[0-9a-f]{64}$/u);

    const secondHarnessView = harness.createService();
    await expect(secondHarnessView.read(context, harness.documentId)).resolves.toEqual(result.workflow);
  });

  it("commits a collaborative workflow change and its exact-generation notification before delivery", async () => {
    const harness = await createHarness("notification-commit-first");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    initialized.document.destroy();
    const notifyWorkflowChanged = vi.fn(async () => {
      const [document] = await harness.database.select().from(documents).where(and(
        eq(documents.workspaceId, context.workspaceId),
        eq(documents.id, harness.documentId),
      ));
      const [job] = await harness.database.select().from(collaborationWorkflowNotificationJobs);
      expect(document).toMatchObject({ readiness: "needs_review", revision: 1 });
      expect(job).toMatchObject({
        attempts: 0,
        documentId: harness.documentId,
        generation: 1,
        status: "pending",
        workflowRevision: 1,
        workspaceId: context.workspaceId,
      });
    });
    const service = harness.createService({
      workflowNotificationGateway: { notifyWorkflowChanged },
    });

    await expect(service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).resolves.toMatchObject({ workflow: { readiness: "needs_review", revision: 1 } });

    expect(notifyWorkflowChanged).toHaveBeenCalledWith(
      { workspaceId: context.workspaceId },
      harness.documentId,
      1,
    );
    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([]);
  });

  it("coalesces pending notifications by exact document generation and fences them by revision", async () => {
    const harness = await createHarness("notification-coalesce");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    initialized.document.destroy();

    await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    });
    await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "needs_review",
      nextReadiness: "ready",
    });

    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([
      expect.objectContaining({
        attempts: 0,
        documentId: harness.documentId,
        failureCategory: null,
        generation: 1,
        status: "pending",
        workflowRevision: 2,
        workspaceId: context.workspaceId,
      }),
    ]);
  });

  it("rolls back the workflow transition when its durable notification cannot be enqueued", async () => {
    const harness = await createHarness("notification-rollback");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    initialized.document.destroy();
    await harness.database.run(sql`
      CREATE TRIGGER reject_workflow_notification
      BEFORE INSERT ON collaboration_workflow_notification_jobs
      BEGIN
        SELECT RAISE(ABORT, 'private notification storage failure');
      END
    `);

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).rejects.toMatchObject({ category: "unavailable" });

    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "draft", revision: 0 });
    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([]);
  });

  it("keeps a bounded pending notification when immediate post-commit delivery fails", async () => {
    const harness = await createHarness("notification-delivery-failure");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    initialized.document.destroy();
    const service = harness.createService({
      workflowNotificationGateway: {
        async notifyWorkflowChanged() {
          throw new Error("private room token");
        },
      },
    });

    await expect(service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).resolves.toMatchObject({ workflow: { readiness: "needs_review" } });

    const [job] = await harness.database.select().from(collaborationWorkflowNotificationJobs);
    expect(job).toMatchObject({
      attempts: 1,
      failureCategory: "delivery_failed",
      nextAttemptAt: new Date(6_000),
      status: "pending",
      workflowRevision: 1,
    });
    expect(JSON.stringify(job)).not.toContain("private room token");
  });

  it("rejects stale approval heads and expected readiness without creating an approval", async () => {
    const harness = await createHarness("stale");
    await harness.persistence.initialize(context, harness.documentId);
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 1,
    })).rejects.toMatchObject({ category: "head_conflict" });
    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).rejects.toMatchObject({ category: "expected_readiness_conflict" });

    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(0);
    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "ready" });
  });

  it("lets exactly one concurrent approval win", async () => {
    const harness = await createHarness("concurrent-approval");
    await harness.persistence.initialize(context, harness.documentId);
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));

    const results = await Promise.allSettled([
      harness.service.execute(context, harness.documentId, {
        expectedReadiness: "ready",
        nextReadiness: "approved",
        observedHeadSeq: 0,
      }),
      harness.service.execute({ ...context, requestId: "request-b" }, harness.documentId, {
        expectedReadiness: "ready",
        nextReadiness: "approved",
        observedHeadSeq: 0,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(1);
  });

  it("rolls back a prepared approval when the readiness compare-and-set does not update", async () => {
    const harness = await createHarness("approval-cas-rollback");
    await harness.persistence.initialize(context, harness.documentId);
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.database.run(sql`
      CREATE TRIGGER ignore_approval_transition
      BEFORE UPDATE OF readiness ON documents
      WHEN NEW.readiness = 'approved'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 0,
    })).rejects.toMatchObject({ category: "expected_readiness_conflict" });

    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(0);
    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "ready" });
  });

  it("rejects a no-op transition without incrementing revision", async () => {
    const harness = await createHarness("no-op-transition");

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "draft",
    })).rejects.toMatchObject({ category: "invalid_request" });

    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "draft", revision: 0 });
  });

  it("invalidates the exact approval on the first changed update but preserves it for a no-op", async () => {
    const harness = await createHarness("invalidate");
    const snapshot = await harness.persistence.initialize(context, harness.documentId);
    snapshot.document.destroy();
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 0,
    });
    const canonical = await harness.persistence.load(context, harness.documentId);
    if (!canonical) throw new Error("expected collaboration snapshot");
    const noOp = Y.encodeStateAsUpdate(canonical.document);
    const before = Y.encodeStateVector(canonical.document);
    canonical.document.getText(COLLABORATION_TITLE_NAME).insert(
      canonical.document.getText(COLLABORATION_TITLE_NAME).length,
      " changed",
    );
    const changed = Y.encodeStateAsUpdate(canonical.document, before);
    canonical.document.destroy();

    await harness.persistence.appendValidatedUpdate(context, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "approved-noop",
      originKind: "client",
      principalId: context.principalId,
      requestId: "noop-request",
      sessionId: "session-a",
      update: noOp,
    });
    expect((await harness.database.select().from(documentApprovals))[0]).toMatchObject({ invalidatedAt: null });
    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "approved" });

    await harness.persistence.appendValidatedUpdate(context, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "approved-change",
      originKind: "client",
      principalId: "principal-editor",
      requestId: "change-request",
      sessionId: "session-a",
      update: changed,
    });

    expect((await harness.database.select().from(documentApprovals))[0]).toMatchObject({
      invalidatedPrincipalId: "principal-editor",
      invalidatedSeq: 1,
    });
    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "needs_review" });
  });

  it("revokes an active approval atomically when workflow moves away from approved and permits re-approval", async () => {
    const harness = await createHarness("approval-revocation");
    const snapshot = await harness.persistence.initialize(context, harness.documentId);
    snapshot.document.destroy();
    await harness.database.update(documents).set({ readiness: "ready" }).where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, harness.documentId),
    ));
    await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 0,
    });

    const demoted = await harness.service.execute(
      { ...context, requestId: "demotion-request" },
      harness.documentId,
      { expectedReadiness: "approved", nextReadiness: "ready" },
    );

    expect(demoted.workflow).toMatchObject({ readiness: "ready", revision: 2 });
    const [revoked] = await harness.database.select().from(documentApprovals);
    expect(revoked).toMatchObject({
      invalidatedAt: null,
      revokedAt: new Date(5_000),
      revokedPrincipalId: context.principalId,
      revokedRequestId: "demotion-request",
    });

    await expect(harness.service.execute(
      { ...context, requestId: "second-approval" },
      harness.documentId,
      { expectedReadiness: "ready", nextReadiness: "approved", observedHeadSeq: 0 },
    )).resolves.toMatchObject({ workflow: { readiness: "approved", revision: 3 } });
    const approvals = await harness.database.select().from(documentApprovals);
    expect(approvals).toHaveLength(2);
    expect(approvals.filter((approval) => !approval.invalidatedAt && !approval.revokedAt)).toHaveLength(1);
  });

  it("supports legacy readiness transitions but fails closed for unversioned legacy approval", async () => {
    const harness = await createHarness("legacy");

    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).resolves.toMatchObject({ workflow: { collaboration: null, readiness: "needs_review" } });
    await harness.service.execute(context, harness.documentId, {
      expectedReadiness: "needs_review",
      nextReadiness: "ready",
    });
    await expect(harness.service.execute(context, harness.documentId, {
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 0,
    })).rejects.toMatchObject({ category: "legacy_approval_unsupported" });

    await expect(harness.readDocument()).resolves.toMatchObject({ readiness: "ready", revision: 2 });
    await expect(harness.database.select().from(documentApprovals)).resolves.toHaveLength(0);
    await expect(harness.database.select().from(collaborationWorkflowNotificationJobs)).resolves.toEqual([]);
  });

  it("does not reveal archived, missing, or another Workspace document", async () => {
    const harness = await createHarness("isolation");
    const other = { ...context, principalId: "other", workspaceId: "workspace-b" };

    await expect(harness.service.read(other, harness.documentId)).rejects.toMatchObject({ category: "not_found" });
    await expect(harness.service.execute(other, harness.documentId, {
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    })).rejects.toMatchObject({ category: "not_found" });
    await harness.database.update(documents).set({ status: "archived" }).where(eq(documents.id, harness.documentId));
    await expect(harness.service.read(context, harness.documentId)).rejects.toMatchObject({ category: "not_found" });
  });

  it("fails closed when the marked current generation is not the latest generation", async () => {
    const harness = await createHarness("stale-current-generation");
    const initialized = await harness.persistence.initialize(context, harness.documentId);
    initialized.document.destroy();
    const [firstGeneration] = await harness.database.select().from(collaborationDocuments);
    if (!firstGeneration) throw new Error("expected initialized generation");
    await harness.database.insert(collaborationDocuments).values({
      ...firstGeneration,
      generation: 2,
      isCurrent: false,
    });

    await expect(harness.service.read(context, harness.documentId)).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("maps unknown database failures to a bounded content-free unavailable error", async () => {
    const secret = "document-id content hash token state-vector";
    const service = createDocumentWorkflowService({
      authorizeWorkflow: () => true,
      codec: createCollaborationDocumentCodec(profile),
      database: {
        $client: { transaction: () => Promise.reject(new Error(secret)) },
      } as never,
      persistence: {
        load: () => Promise.reject(new Error(secret)),
        withInitializedWrite: () => Promise.reject(new Error(secret)),
      } as never,
      projectProfile: profile,
    });

    const failure = await captureWorkflowFailure(() => service.read(context, "document-secret"));

    expect(failure).toMatchObject({ category: "unavailable" });
    expect(failure.message).not.toMatch(/document-id|content|hash|token|vector|secret/iu);
    expect(failure.message.length).toBeLessThan(100);
  });
});

async function createHarness(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-workflow-${label}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "workflow.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  const documentId = `document-${label}`;
  await database.insert(documents).values({
    contentJson: { content: [{ content: [{ text: "Body", type: "text" }], type: "paragraph" }], type: "doc" },
    createdAt: new Date(1_000),
    id: documentId,
    metadataJson: { owner: "Ada" },
    plainText: "Body",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Workflow draft",
    updatedAt: new Date(1_000),
    workspaceId: context.workspaceId,
  });
  const codec = createCollaborationDocumentCodec(profile);
  const persistence = createCollaborationPersistence(database, { codec, projectProfile: profile });
  const createService = (
    overrides: Partial<Parameters<typeof createDocumentWorkflowService>[0]> = {},
  ) => createDocumentWorkflowService({
    authorizeWorkflow: () => true,
    codec,
    database,
    now: () => new Date(5_000),
    persistence,
    projectProfile: profile,
    ...overrides,
  });
  return {
    codec,
    createService,
    database,
    documentId,
    persistence,
    readDocument: async () => {
      const [document] = await database.select().from(documents).where(and(
        eq(documents.workspaceId, context.workspaceId),
        eq(documents.id, documentId),
      ));
      if (!document) throw new Error("expected document");
      return document;
    },
    service: createService(),
  };
}

async function captureWorkflowFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DocumentWorkflowServiceError) return error;
    throw error;
  }
  throw new Error("expected workflow service error");
}
