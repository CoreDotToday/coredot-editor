import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import * as schema from "@/db/schema";
import {
  aiProposals,
  aiRuns,
  collaborationActions,
  collaborationCommandDeliveryJobs,
  collaborationDocuments,
  collaborationProposalAnchors,
  collaborationUpdates,
  documentChangeProposals,
  documentChanges,
  documents,
} from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { claimLocalWorkspace } from "../../../scripts/db/claim-local-workspace";

import { COLLABORATION_BODY_NAME, COLLABORATION_METADATA_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import { createCollaborationPersistence } from "./persistence";
import { createCollaborativeProposalAnchor } from "./proposal-command";
import { createCollaborativeProposalService } from "./proposal-command-service";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const clients: Client[] = [];
const tempDirs: string[] = [];
const scope = { workspaceId: "workspace-proposal" };
const context = {
  ...scope,
  authMode: "test" as const,
  principalId: "principal-proposal",
  requestId: "request-proposal",
  role: "owner" as const,
};

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("CollaborativeProposalService", () => {
  it("atomically applies a relative-anchor Proposal after an unrelated edit before its target", async () => {
    const harness = await createHarness("edit-before");
    const proposal = await harness.seedProposal("proposal-beta", { from: 7, replacementText: "BETTER", to: 11 });
    const current = await harness.persistence.load(scope, harness.documentId);
    if (!current) throw new Error("missing current collaboration document");
    const before = Y.encodeStateVector(current.document);
    firstXmlText(current.document).insert(0, "preface ");
    await harness.persistence.appendValidatedUpdate(scope, {
      documentId: harness.documentId,
      generation: current.generation,
      idempotencyKey: "client-before-target",
      originKind: "client",
      principalId: "principal-peer",
      requestId: "request-peer",
      sessionId: "session-peer",
      update: Y.encodeStateAsUpdate(current.document, before),
    });

    const result = await harness.service.apply(context, {
      commandId: "command-edit-before",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 0,
    });

    expect(result).toMatchObject({
      collaboration: { generation: 1, headSeq: 2 },
      ok: true,
      proposals: [{ id: proposal.id, status: "accepted" }],
    });
    const loaded = await harness.persistence.load(scope, harness.documentId);
    expect(harness.codec.materialize(loaded!.document).plainText).toBe("preface alpha BETTER gamma");
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([
      expect.objectContaining({
        actionType: "proposal_apply",
        commandId: "command-edit-before",
        status: "applied",
      }),
    ]);
    await expect(harness.database.select().from(documentChanges)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(documentChangeProposals)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({ generation: 1, seq: 2, status: "pending" }),
    ]);
    await expect(harness.database.select().from(collaborationDocuments).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.isCurrent, true),
    ))).resolves.toEqual([
      expect.objectContaining({ generation: 1, headSeq: 2, projectedSeq: 2 }),
    ]);
  });

  it("fails closed without status or audit mutation when the anchored target changed", async () => {
    const harness = await createHarness("target-conflict");
    const proposal = await harness.seedProposal("proposal-beta", { from: 7, replacementText: "BETTER", to: 11 });
    const current = await harness.persistence.load(scope, harness.documentId);
    const before = Y.encodeStateVector(current!.document);
    firstXmlText(current!.document).insert(8, "X");
    await harness.persistence.appendValidatedUpdate(scope, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "client-target-change",
      originKind: "client",
      principalId: "principal-peer",
      requestId: "request-peer",
      sessionId: "session-peer",
      update: Y.encodeStateAsUpdate(current!.document, before),
    });
    const durableBefore = await harness.database.select().from(collaborationUpdates);

    await expect(harness.service.apply(context, {
      commandId: "command-target-conflict",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: 1,
    })).resolves.toEqual({ ok: false, reason: "proposal_target_conflict" });

    await expect(harness.database.select().from(aiProposals)).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, status: "pending" }),
    ]);
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([]);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(durableBefore.length);
    await expect(harness.database.select().from(documentChanges)).resolves.toEqual([]);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([]);
  });

  it("returns a permanent target conflict without mutation when the anchored generation was rotated", async () => {
    const harness = await createHarness("stale-anchor-generation");
    const proposal = await harness.seedProposal(
      "proposal-stale-generation",
      { from: 7, replacementText: "BETTER", to: 11 },
    );
    const [current] = await harness.database.select().from(collaborationDocuments).where(and(
      eq(collaborationDocuments.workspaceId, scope.workspaceId),
      eq(collaborationDocuments.documentId, harness.documentId),
      eq(collaborationDocuments.isCurrent, true),
    ));
    const rotatedAt = new Date(current!.updatedAt.valueOf() + 1);
    await harness.database.transaction(async (transaction) => {
      await transaction.update(collaborationDocuments).set({
        isCurrent: false,
        updatedAt: rotatedAt,
      }).where(and(
        eq(collaborationDocuments.workspaceId, scope.workspaceId),
        eq(collaborationDocuments.documentId, harness.documentId),
        eq(collaborationDocuments.generation, current!.generation),
      ));
      await transaction.insert(collaborationDocuments).values({
        checkpointBlob: current!.checkpointBlob,
        checkpointChecksum: current!.checkpointChecksum,
        checkpointSeq: current!.checkpointSeq,
        createdAt: rotatedAt,
        documentId: harness.documentId,
        generation: current!.generation + 1,
        headSeq: current!.headSeq,
        isCurrent: true,
        lastCheckpointAt: rotatedAt,
        projectedSeq: current!.projectedSeq,
        schemaFingerprint: current!.schemaFingerprint,
        schemaVersion: current!.schemaVersion,
        updatedAt: rotatedAt,
        workspaceId: scope.workspaceId,
      });
    });
    const beforeDocument = await harness.database.select().from(documents);

    await expect(harness.service.apply(context, {
      commandId: "command-stale-generation",
      items: [{ mode: "replace", proposalId: proposal.id }],
      observedHeadSeq: current!.headSeq,
    })).resolves.toEqual({ ok: false, reason: "proposal_target_conflict" });

    await expect(harness.database.select().from(aiProposals)).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, status: "pending" }),
    ]);
    await expect(harness.database.select().from(documents)).resolves.toEqual(beforeDocument);
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([]);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toEqual([]);
    await expect(harness.database.select().from(documentChanges)).resolves.toEqual([]);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([]);
  });

  it("rejects an overlapping batch before every Proposal status mutation", async () => {
    const harness = await createHarness("overlap");
    const first = await harness.seedProposal("proposal-first", { from: 1, replacementText: "one", to: 11 });
    const second = await harness.seedProposal("proposal-second", { from: 7, replacementText: "two", to: 17 });

    await expect(harness.service.apply(context, {
      commandId: "command-overlap",
      items: [
        { mode: "replace", proposalId: first.id },
        { mode: "replace", proposalId: second.id },
      ],
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "proposal_overlap_conflict" });

    expect((await harness.database.select().from(aiProposals)).map(({ status }) => status)).toEqual([
      "pending",
      "pending",
    ]);
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([]);
  });

  it("keeps both Proposal statuses pending when insert-below targets share one top-level block", async () => {
    const harness = await createHarness("insert-footprint-overlap");
    const first = await harness.seedProposal("proposal-after-alpha", { from: 1, replacementText: "A", to: 6 });
    const second = await harness.seedProposal("proposal-after-beta", { from: 7, replacementText: "B", to: 11 });
    const before = await harness.persistence.load(scope, harness.documentId);
    const beforeUpdate = Y.encodeStateAsUpdate(before!.document);

    await expect(harness.service.apply(context, {
      commandId: "command-insert-footprint-overlap",
      items: [
        { mode: "insert_below", proposalId: first.id },
        { mode: "insert_below", proposalId: second.id },
      ],
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "proposal_overlap_conflict" });

    expect((await harness.database.select().from(aiProposals)).map(({ status }) => status)).toEqual([
      "pending",
      "pending",
    ]);
    const after = await harness.persistence.load(scope, harness.documentId);
    expect(Y.encodeStateAsUpdate(after!.document)).toEqual(beforeUpdate);
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([]);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([]);
  });

  it("replays an exact command and rejects command-id payload or Principal reuse", async () => {
    const harness = await createHarness("replay");
    const proposal = await harness.seedProposal("proposal-beta", { from: 7, replacementText: "BETTER", to: 11 });
    const input = {
      commandId: "command-replay",
      items: [{ mode: "replace" as const, proposalId: proposal.id }],
      observedHeadSeq: 0,
    };
    const first = await harness.service.apply(context, input);
    const [delivery] = await harness.database.select().from(collaborationCommandDeliveryJobs);
    await harness.database.update(collaborationCommandDeliveryJobs).set({
      attempts: 5,
      failureCategory: "delivery_failed",
      nextAttemptAt: null,
      status: "exhausted",
      updatedAt: delivery!.createdAt,
    });
    const replay = await harness.service.apply(
      { ...context, requestId: "request-retry" },
      { ...input, observedHeadSeq: 99 },
    );

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    await expect(harness.service.apply(context, {
      ...input,
      items: [{ mode: "insert_below", proposalId: proposal.id }],
    })).resolves.toEqual({ ok: false, reason: "idempotency_conflict" });
    await expect(harness.service.apply({ ...context, principalId: "principal-other" }, input))
      .resolves.toEqual({ ok: false, reason: "idempotency_conflict" });
    await expect(harness.database.select().from(documentChanges)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({ attempts: 0, failureCategory: null, status: "pending" }),
    ]);
  });

  it("replays an exact lost response when the command rotated generation N to N+1", async () => {
    const harness = await createHarness("rotated-command-replay");
    const proposal = await harness.seedProposal(
      "proposal-rotated-command",
      { from: 7, replacementText: "BETTER", to: 11 },
    );
    const current = await harness.persistence.load(scope, harness.documentId);
    if (!current) throw new Error("missing current collaboration document");
    const beforeTail = Y.encodeStateVector(current.document);
    firstXmlText(current.document).insert(0, "preface ".repeat(64));
    await harness.persistence.appendValidatedUpdate(scope, {
      documentId: harness.documentId,
      generation: current.generation,
      idempotencyKey: "rotation-tail",
      originKind: "client",
      principalId: "principal-peer",
      requestId: "request-peer",
      sessionId: "session-peer",
      update: Y.encodeStateAsUpdate(current.document, beforeTail),
    });
    const observedHeadSeq = await inflateCurrentTailForRotation(harness, scope, "rotation-tail");
    const cumulativeUpdateBytes = await rotationLimitForBoundedCandidate(harness, scope);
    const rotatingPersistence = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile: getProjectProfile("default"),
      storageLimits: { cumulativeUpdateBytes },
    });
    const rotatingService = createCollaborativeProposalService({
      database: harness.database,
      persistence: rotatingPersistence,
    });
    const input = {
      commandId: "command-rotates-generation",
      items: [{ mode: "replace" as const, proposalId: proposal.id }],
      observedHeadSeq,
    };

    await expect(rotatingService.apply(context, input)).resolves.toMatchObject({
      collaboration: { generation: 2 },
      ok: true,
      replayed: false,
    });
    await expect(rotatingService.apply({ ...context, requestId: "request-rotated-retry" }, input))
      .resolves.toMatchObject({
        collaboration: { generation: 2 },
        ok: true,
        replayed: true,
      });
  });

  it("fails closed without outbox rearm when a retired command update blob no longer matches its checksum", async () => {
    const harness = await createHarness("corrupt-retired-command");
    const proposal = await harness.seedProposal(
      "proposal-corrupt-retired-command",
      { from: 7, replacementText: "BETTER", to: 11 },
    );
    const input = {
      commandId: "command-corrupt-after-retirement",
      items: [{ mode: "replace" as const, proposalId: proposal.id }],
      observedHeadSeq: 0,
    };
    await expect(harness.service.apply(context, input)).resolves.toMatchObject({ ok: true, replayed: false });
    const [commandUpdate] = await harness.database.select().from(collaborationUpdates).where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.idempotencyKey, input.commandId),
    ));
    if (!commandUpdate) throw new Error("missing committed command");
    await harness.database.update(collaborationCommandDeliveryJobs).set({
      attempts: 5,
      failureCategory: "delivery_failed",
      nextAttemptAt: null,
      status: "exhausted",
    });
    const current = await harness.persistence.load(scope, harness.documentId);
    if (!current) throw new Error("missing current collaboration document");
    const beforeTail = Y.encodeStateVector(current.document);
    current.document.getMap(COLLABORATION_METADATA_NAME).set("category", "before-rotation");
    await harness.persistence.appendValidatedUpdate(scope, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "retirement-tail",
      originKind: "client",
      principalId: "principal-peer",
      requestId: "request-peer-tail",
      sessionId: "session-peer",
      update: Y.encodeStateAsUpdate(current.document, beforeTail),
    });
    await inflateCurrentTailForRotation(harness, scope, "retirement-tail");
    const beforeRotation = Y.encodeStateVector(current.document);
    current.document.getMap(COLLABORATION_METADATA_NAME).set("category", "rotated");
    const rotationUpdate = Y.encodeStateAsUpdate(current.document, beforeRotation);
    const cumulativeUpdateBytes = await rotationLimitForBoundedCandidate(
      harness,
      scope,
      rotationUpdate.byteLength + 128,
    );
    const rotatingPersistence = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile: getProjectProfile("default"),
      storageLimits: { cumulativeUpdateBytes },
    });
    await expect(rotatingPersistence.appendValidatedUpdate(scope, {
      documentId: harness.documentId,
      generation: 1,
      idempotencyKey: "rotate-after-command",
      originKind: "client",
      principalId: "principal-peer",
      requestId: "request-peer",
      sessionId: "session-peer",
      update: rotationUpdate,
    })).resolves.toMatchObject({ generation: 2 });
    await harness.database.update(collaborationUpdates).set({
      updateBlob: Buffer.from([0]),
    }).where(and(
      eq(collaborationUpdates.workspaceId, scope.workspaceId),
      eq(collaborationUpdates.documentId, harness.documentId),
      eq(collaborationUpdates.idempotencyKey, input.commandId),
    ));

    await expect(harness.service.apply({ ...context, requestId: "request-corrupt-retry" }, input))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toEqual([
      expect.objectContaining({ attempts: 5, failureCategory: "delivery_failed", status: "exhausted" }),
    ]);
  });

  it("replays an exact stored action id after the local Workspace graph is claimed without id rewriting", async () => {
    const localScope = { workspaceId: "local" };
    const localContext = { ...context, ...localScope };
    const harness = await createHarness("claimed-action-replay", localScope);
    const proposal = await harness.seedProposal(
      "proposal-claimed-action",
      { from: 7, replacementText: "BETTER", to: 11 },
    );
    const input = {
      commandId: "command-before-workspace-claim",
      items: [{ mode: "replace" as const, proposalId: proposal.id }],
      observedHeadSeq: 0,
    };
    await expect(harness.service.apply(localContext, input)).resolves.toMatchObject({ ok: true, replayed: false });
    const [beforeClaim] = await harness.database.select().from(collaborationActions);
    if (!beforeClaim) throw new Error("missing action before claim");

    const targetScope = { workspaceId: "workspace-claimed" };
    await claimLocalWorkspace(harness.client, targetScope.workspaceId);
    const claimedPersistence = createCollaborationPersistence(harness.database, {
      codec: harness.codec,
      projectProfile: getProjectProfile("default"),
    });
    const claimedService = createCollaborativeProposalService({
      database: harness.database,
      persistence: claimedPersistence,
    });

    await expect(claimedService.apply({
      ...localContext,
      ...targetScope,
      requestId: "request-after-workspace-claim",
    }, input)).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(harness.database.select().from(collaborationActions)).resolves.toEqual([
      expect.objectContaining({ id: beforeClaim.id, workspaceId: targetScope.workspaceId }),
    ]);
  });

  it("returns a stable idempotency conflict when one Workspace reuses a command id on another document", async () => {
    const harness = await createHarness("workspace-document-command");
    const firstProposal = await harness.seedProposal(
      "proposal-first-document",
      { from: 7, replacementText: "FIRST", to: 11 },
    );
    const second = await harness.seedAdditionalDocumentProposal(
      "second",
      "proposal-second-document",
      { from: 7, replacementText: "SECOND", to: 11 },
    );
    const sharedCommandId = "command-shared-by-documents";

    await expect(harness.service.apply(context, {
      commandId: sharedCommandId,
      items: [{ mode: "replace", proposalId: firstProposal.id }],
      observedHeadSeq: 0,
    })).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(harness.service.apply(context, {
      commandId: sharedCommandId,
      items: [{ mode: "replace", proposalId: second.proposal.id }],
      observedHeadSeq: 0,
    })).resolves.toEqual({ ok: false, reason: "idempotency_conflict" });

    await expect(harness.database.select().from(collaborationActions)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(documentChanges)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(aiProposals).where(and(
      eq(aiProposals.workspaceId, scope.workspaceId),
      eq(aiProposals.id, second.proposal.id),
    ))).resolves.toEqual([expect.objectContaining({ status: "pending" })]);
    await expect(harness.persistence.load(scope, second.documentId)).resolves.toMatchObject({ headSeq: 0 });
  });

  it("recovers a Workspace command-id unique race as one commit and one stable conflict", async () => {
    const harness = await createHarness("workspace-command-race");
    const firstProposal = await harness.seedProposal(
      "proposal-race-first",
      { from: 7, replacementText: "FIRST", to: 11 },
    );
    const second = await harness.seedAdditionalDocumentProposal(
      "second",
      "proposal-race-second",
      { from: 7, replacementText: "SECOND", to: 11 },
    );
    const sharedCommandId = "command-raced-by-documents";

    const outcomes = await Promise.all([
      harness.service.apply(context, {
        commandId: sharedCommandId,
        items: [{ mode: "replace", proposalId: firstProposal.id }],
        observedHeadSeq: 0,
      }),
      harness.service.apply(context, {
        commandId: sharedCommandId,
        items: [{ mode: "replace", proposalId: second.proposal.id }],
        observedHeadSeq: 0,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, reason: "idempotency_conflict" },
    ]);
    await expect(harness.database.select().from(collaborationActions)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(documentChanges)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationCommandDeliveryJobs)).resolves.toHaveLength(1);
    await expect(harness.database.select().from(collaborationUpdates)).resolves.toHaveLength(1);
  });

  it("keeps a stable globally unique action identity when two Workspaces use the same command id", async () => {
    const harness = await createHarness("workspace-action-id");
    const firstProposal = await harness.seedProposal(
      "proposal-first-workspace",
      { from: 7, replacementText: "FIRST", to: 11 },
    );
    const secondScope = { workspaceId: "workspace-proposal-two" };
    const secondContext = {
      ...context,
      ...secondScope,
      principalId: "principal-proposal-two",
      requestId: "request-proposal-two",
    };
    const secondDocumentId = "document-second-workspace";
    const timestamp = new Date(1_000);
    await harness.database.insert(documents).values({
      contentJson: paragraphDocument("alpha beta gamma"),
      createdAt: timestamp,
      id: secondDocumentId,
      metadataJson: {},
      plainText: "alpha beta gamma",
      readiness: "draft",
      revision: 0,
      status: "draft",
      title: "Second Workspace",
      updatedAt: timestamp,
      workspaceId: secondScope.workspaceId,
    });
    const secondInitial = await harness.persistence.initialize(secondScope, secondDocumentId);
    await harness.database.insert(aiRuns).values({
      commandType: "document_review",
      createdAt: timestamp,
      documentId: secondDocumentId,
      errorMessage: null,
      executionToken: null,
      id: "run-second-workspace",
      idempotencyKey: "run-key-second-workspace",
      inputSummaryJson: {},
      model: "stub-editor",
      operationFingerprint: "b".repeat(64),
      outputText: "",
      provider: "stub",
      retryNotBeforeAt: null,
      status: "completed",
      updatedAt: timestamp,
      wasApplied: false,
      workspaceId: secondScope.workspaceId,
    });
    const targetText = harness.codec.materialize(secondInitial.document).plainText.slice(6, 10);
    const [secondProposal] = await harness.database.insert(aiProposals).values({
      aiRunId: "run-second-workspace",
      createdAt: timestamp,
      documentId: secondDocumentId,
      explanation: "Improve text",
      id: "proposal-second-workspace",
      replacementText: "SECOND",
      resultOrdinal: 0,
      source: "review",
      status: "pending",
      targetFrom: 7,
      targetText,
      targetTo: 11,
      updatedAt: timestamp,
      workspaceId: secondScope.workspaceId,
    }).returning();
    const secondAnchor = createCollaborativeProposalAnchor(secondInitial.document, {
      baseHeadSeq: secondInitial.headSeq,
      generation: secondInitial.generation,
      range: { from: 7, to: 11 },
      schemaFingerprint: secondInitial.schemaFingerprint,
    });
    await harness.database.insert(collaborationProposalAnchors).values({
      ...secondAnchor,
      baseStateVector: Buffer.from(secondAnchor.baseStateVector),
      createdAt: timestamp,
      documentId: secondDocumentId,
      endRelative: Buffer.from(secondAnchor.endRelative),
      proposalId: secondProposal!.id,
      startRelative: Buffer.from(secondAnchor.startRelative),
      workspaceId: secondScope.workspaceId,
    });
    const sharedCommandId = "command-shared-by-workspaces";
    const firstInput = {
      commandId: sharedCommandId,
      items: [{ mode: "replace" as const, proposalId: firstProposal.id }],
      observedHeadSeq: 0,
    };
    const secondInput = {
      commandId: sharedCommandId,
      items: [{ mode: "replace" as const, proposalId: secondProposal!.id }],
      observedHeadSeq: 0,
    };
    const legacyGlobalCollisionId = createHash("sha256").update(JSON.stringify({
      commandId: sharedCommandId,
      documentId: secondDocumentId,
      kind: "collaboration_proposal_action",
    })).digest("hex");
    await harness.database.insert(collaborationActions).values({
      actionType: "repair",
      appliedHeadSeq: null,
      baseHeadSeq: 0,
      commandFingerprint: "d".repeat(64),
      commandId: "legacy-global-action-id-reservation",
      createdAt: timestamp,
      documentChangeId: null,
      documentId: harness.documentId,
      failureCategory: null,
      generation: 1,
      id: legacyGlobalCollisionId,
      principalId: context.principalId,
      proposalId: null,
      requestId: "legacy-global-action-id-reservation",
      status: "pending",
      updatedAt: timestamp,
      workspaceId: context.workspaceId,
    });

    await expect(harness.service.apply(context, firstInput)).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(harness.service.apply(secondContext, secondInput)).resolves.toMatchObject({
      ok: true,
      replayed: false,
    });
    await expect(harness.service.apply({ ...context, requestId: "request-first-replay" }, firstInput))
      .resolves.toMatchObject({ ok: true, replayed: true });
    await expect(harness.service.apply({ ...secondContext, requestId: "request-second-replay" }, secondInput))
      .resolves.toMatchObject({ ok: true, replayed: true });
    const actions = await harness.database.select().from(collaborationActions);
    expect(actions).toHaveLength(3);
    expect(new Set(actions.map(({ id }) => id)).size).toBe(3);
    expect(actions.filter(({ commandId }) => commandId === sharedCommandId)).toHaveLength(2);
  });
});

async function createHarness(label: string, activeScope = scope) {
  const directory = await mkdtemp(join(tmpdir(), `coredot-proposal-command-${label}-`));
  tempDirs.push(directory);
  const client = createClient({ url: `file:${join(directory, "command.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  await client.execute("PRAGMA foreign_keys=ON");
  const documentId = `document-${label}`;
  const timestamp = new Date(1_000);
  await database.insert(documents).values({
    contentJson: paragraphDocument("alpha beta gamma"),
    createdAt: timestamp,
    id: documentId,
    metadataJson: {},
    plainText: "alpha beta gamma",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Proposal command",
    updatedAt: timestamp,
    workspaceId: activeScope.workspaceId,
  });
  const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
  const persistence = createCollaborationPersistence(database, { codec, projectProfile: getProjectProfile("default") });
  const initial = await persistence.initialize(activeScope, documentId);
  await database.insert(aiRuns).values({
    commandType: "document_review",
    createdAt: timestamp,
    documentId,
    errorMessage: null,
    executionToken: null,
    id: `run-${label}`,
    idempotencyKey: `run-key-${label}`,
    inputSummaryJson: {},
    model: "stub-editor",
    operationFingerprint: "a".repeat(64),
    outputText: "",
    provider: "stub",
    retryNotBeforeAt: null,
    status: "completed",
    updatedAt: timestamp,
    wasApplied: false,
    workspaceId: activeScope.workspaceId,
  });
  const service = createCollaborativeProposalService({ database, persistence });
  return {
    codec,
    client,
    database,
    documentId,
    persistence,
    service,
    async seedProposal(
      proposalId: string,
      input: { from: number; replacementText: string; to: number },
    ) {
      const targetText = codec.materialize(initial.document).plainText.slice(input.from - 1, input.to - 1);
      const [proposal] = await database.insert(aiProposals).values({
        aiRunId: `run-${label}`,
        createdAt: timestamp,
        documentId,
        explanation: "Improve text",
        id: proposalId,
        replacementText: input.replacementText,
        resultOrdinal: Number((await database.select().from(aiProposals)).length),
        source: "review",
        status: "pending",
        targetFrom: input.from,
        targetText,
        targetTo: input.to,
        updatedAt: timestamp,
        workspaceId: activeScope.workspaceId,
      }).returning();
      const anchor = createCollaborativeProposalAnchor(initial.document, {
        baseHeadSeq: initial.headSeq,
        generation: initial.generation,
        range: { from: input.from, to: input.to },
        schemaFingerprint: initial.schemaFingerprint,
      });
      await database.insert(collaborationProposalAnchors).values({
        ...anchor,
        baseStateVector: Buffer.from(anchor.baseStateVector),
        createdAt: timestamp,
        documentId,
        endRelative: Buffer.from(anchor.endRelative),
        proposalId,
        startRelative: Buffer.from(anchor.startRelative),
        workspaceId: activeScope.workspaceId,
      });
      return proposal!;
    },
    async seedAdditionalDocumentProposal(
      documentLabel: string,
      proposalId: string,
      input: { from: number; replacementText: string; to: number },
    ) {
      const additionalDocumentId = `document-${label}-${documentLabel}`;
      const runId = `run-${label}-${documentLabel}`;
      await database.insert(documents).values({
        contentJson: paragraphDocument("alpha beta gamma"),
        createdAt: timestamp,
        id: additionalDocumentId,
        metadataJson: {},
        plainText: "alpha beta gamma",
        readiness: "draft",
        revision: 0,
        status: "draft",
        title: "Additional proposal command",
        updatedAt: timestamp,
        workspaceId: activeScope.workspaceId,
      });
      const additionalInitial = await persistence.initialize(activeScope, additionalDocumentId);
      await database.insert(aiRuns).values({
        commandType: "document_review",
        createdAt: timestamp,
        documentId: additionalDocumentId,
        errorMessage: null,
        executionToken: null,
        id: runId,
        idempotencyKey: `run-key-${label}-${documentLabel}`,
        inputSummaryJson: {},
        model: "stub-editor",
        operationFingerprint: "c".repeat(64),
        outputText: "",
        provider: "stub",
        retryNotBeforeAt: null,
        status: "completed",
        updatedAt: timestamp,
        wasApplied: false,
        workspaceId: activeScope.workspaceId,
      });
      const targetText = codec.materialize(additionalInitial.document).plainText.slice(input.from - 1, input.to - 1);
      const [proposal] = await database.insert(aiProposals).values({
        aiRunId: runId,
        createdAt: timestamp,
        documentId: additionalDocumentId,
        explanation: "Improve text",
        id: proposalId,
        replacementText: input.replacementText,
        resultOrdinal: 0,
        source: "review",
        status: "pending",
        targetFrom: input.from,
        targetText,
        targetTo: input.to,
        updatedAt: timestamp,
        workspaceId: activeScope.workspaceId,
      }).returning();
      const anchor = createCollaborativeProposalAnchor(additionalInitial.document, {
        baseHeadSeq: additionalInitial.headSeq,
        generation: additionalInitial.generation,
        range: { from: input.from, to: input.to },
        schemaFingerprint: additionalInitial.schemaFingerprint,
      });
      await database.insert(collaborationProposalAnchors).values({
        ...anchor,
        baseStateVector: Buffer.from(anchor.baseStateVector),
        createdAt: timestamp,
        documentId: additionalDocumentId,
        endRelative: Buffer.from(anchor.endRelative),
        proposalId,
        startRelative: Buffer.from(anchor.startRelative),
        workspaceId: activeScope.workspaceId,
      });
      return { documentId: additionalDocumentId, proposal: proposal! };
    },
  };
}

function paragraphDocument(text: string) {
  return { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function firstXmlText(document: Y.Doc): Y.XmlText {
  const queue: Array<Y.XmlElement | Y.XmlFragment> = [document.getXmlFragment(COLLABORATION_BODY_NAME)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of current.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) queue.push(child);
    }
  }
  throw new Error("Expected collaborative text");
}

async function inflateCurrentTailForRotation(
  harness: Awaited<ReturnType<typeof createHarness>>,
  activeScope: { workspaceId: string },
  sourceIdempotencyKey: string,
) {
  const [generation] = await harness.database.select().from(collaborationDocuments).where(and(
    eq(collaborationDocuments.workspaceId, activeScope.workspaceId),
    eq(collaborationDocuments.documentId, harness.documentId),
    eq(collaborationDocuments.isCurrent, true),
  ));
  const [source] = await harness.database.select().from(collaborationUpdates).where(and(
    eq(collaborationUpdates.workspaceId, activeScope.workspaceId),
    eq(collaborationUpdates.documentId, harness.documentId),
    eq(collaborationUpdates.idempotencyKey, sourceIdempotencyKey),
  ));
  if (!generation || !source) throw new Error("missing rotation tail source");

  const duplicateCount = 128;
  const duplicates = Array.from({ length: duplicateCount }, (_, index) => ({
    ...source,
    createdAt: new Date(10_000 + index),
    idempotencyKey: `${sourceIdempotencyKey}-duplicate-${String(index)}`,
    seq: generation.headSeq + index + 1,
  }));
  await harness.database.insert(collaborationUpdates).values(duplicates);
  const headSeq = generation.headSeq + duplicateCount;
  await harness.database.update(collaborationDocuments).set({ headSeq }).where(and(
    eq(collaborationDocuments.workspaceId, activeScope.workspaceId),
    eq(collaborationDocuments.documentId, harness.documentId),
    eq(collaborationDocuments.generation, generation.generation),
    eq(collaborationDocuments.isCurrent, true),
  ));
  return headSeq;
}

async function rotationLimitForBoundedCandidate(
  harness: Awaited<ReturnType<typeof createHarness>>,
  activeScope: { workspaceId: string },
  candidateBudget = 32 * 1024,
) {
  const current = await harness.persistence.load(activeScope, harness.documentId);
  const [generation] = await harness.database.select().from(collaborationDocuments).where(and(
    eq(collaborationDocuments.workspaceId, activeScope.workspaceId),
    eq(collaborationDocuments.documentId, harness.documentId),
    eq(collaborationDocuments.isCurrent, true),
  ));
  const tails = await harness.database.select({ updateBlob: collaborationUpdates.updateBlob })
    .from(collaborationUpdates)
    .where(and(
      eq(collaborationUpdates.workspaceId, activeScope.workspaceId),
      eq(collaborationUpdates.documentId, harness.documentId),
      eq(collaborationUpdates.generation, generation?.generation ?? -1),
    ));
  if (!current || !generation) throw new Error("missing rotation limit basis");
  const compactCheckpointBytes = harness.codec.encodeCheckpoint(current.document).byteLength;
  const cumulativeUpdateBytes = compactCheckpointBytes + candidateBudget;
  const persistedBytes = generation.checkpointBlob.byteLength
    + tails.reduce((total, row) => total + row.updateBlob.byteLength, 0);
  if (persistedBytes <= cumulativeUpdateBytes) {
    throw new Error("rotation tail did not exceed bounded candidate budget");
  }
  return cumulativeUpdateBytes;
}
