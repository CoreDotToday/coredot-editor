// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { RequestContext, WorkspaceScope } from "@/features/auth/request-context";

import type { CollaborationPersistence, CollaborationSnapshot } from "./persistence";
import {
  CollaborationGatewayError,
  createCollaborativeDocumentGateway,
} from "./gateway";

const scope = { workspaceId: "workspace-a" };
const context: RequestContext = {
  authMode: "clerk",
  principalId: "principal-a",
  requestId: "request-a",
  role: "member",
  workspaceId: scope.workspaceId,
};

describe("CollaborativeDocumentGateway", () => {
  it("returns isolated exact snapshots and verifies a durable state-vector barrier", async () => {
    const fixture = createFixture();
    const first = await fixture.gateway.getSnapshot(scope, "document-a");
    const observed = Y.encodeStateVector(first.document);
    first.document.getText("test").insert(0, "caller mutation");

    const second = await fixture.gateway.getSnapshot(scope, "document-a");
    const barrier = await fixture.gateway.flushBarrier(scope, "document-a", observed);

    expect(second.document.getText("test").toString()).toBe("base");
    expect(barrier).toMatchObject({ documentId: "document-a", generation: 1, headSeq: 0 });
    expect(Y.decodeStateVector(barrier.stateVector)).toEqual(Y.decodeStateVector(observed));
  });

  it("rejects a state vector that canonical durability has not observed", async () => {
    const fixture = createFixture();
    const ahead = new Y.Doc();
    ahead.getText("test").insert(0, "not durable");

    await expect(fixture.gateway.flushBarrier(
      scope,
      "document-a",
      Y.encodeStateVector(ahead),
    )).rejects.toMatchObject({ category: "not_durable" });
  });

  it("plans on a clone, appends durably, and only then publishes a Proposal update", async () => {
    const events: string[] = [];
    const fixture = createFixture({ events });

    const result = await fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-a",
      documentId: "document-a",
      generation: 1,
    });

    expect(events).toEqual(["plan", "append", "publish"]);
    expect(result).toMatchObject({ headSeq: 1, status: "applied" });
    expect(fixture.canonical.getText("test").toString()).toBe("base");
    expect(fixture.appended[0]?.originKind).toBe("proposal_command");
  });

  it("notifies the live room only after an update atomically changed workflow state", async () => {
    const events: string[] = [];
    const fixture = createFixture({ events, workflowChanged: true });

    await fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-workflow-change",
      documentId: "document-a",
      generation: 1,
    });

    expect(events).toEqual(["plan", "append", "publish", "workflow"]);
    expect(fixture.publishWorkflowChanged).toHaveBeenCalledWith(
      scope,
      "document-a",
      1,
    );
  });

  it("does not emit a workflow notification for an ordinary durable update", async () => {
    const fixture = createFixture({ workflowChanged: false });

    await fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-no-workflow-change",
      documentId: "document-a",
      generation: 1,
    });

    expect(fixture.publishWorkflowChanged).not.toHaveBeenCalled();
  });

  it("does not fail a committed command when its best-effort workflow notification throws synchronously", async () => {
    const fixture = createFixture({
      publishWorkflowChanged: () => {
        throw new Error("notification transport failed");
      },
      workflowChanged: true,
    });

    await expect(fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-workflow-notification-failure",
      documentId: "document-a",
      generation: 1,
    })).resolves.toMatchObject({ headSeq: 1, status: "applied" });
  });

  it("closes the source room before publishing to a rotated generation", async () => {
    const events: string[] = [];
    const publish = vi.fn(async () => {
      events.push("publish");
    });
    const fixture = createFixture({ events, publish, receiptGeneration: 2 });

    const result = await fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-rotation",
      documentId: "document-a",
      generation: 1,
    });

    expect(events).toEqual([
      "plan",
      "append",
      "close:collab:v1:workspace-a:document-a:g1",
      "publish",
    ]);
    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g1",
      "room_rotated",
    );
    expect(publish).toHaveBeenCalledWith(
      scope,
      "document-a",
      2,
      expect.any(Uint8Array),
    );
    expect(result.generation).toBe(2);
  });

  it("rejects a selective undo command with an unsafe change id before planning", async () => {
    const publish = vi.fn();
    const fixture = createFixture({ publish });

    await expect(fixture.gateway.undoChange(context, {
      changeId: " change-1",
      commandId: "undo-command-invalid-change",
      documentId: "document-a",
      generation: 1,
    })).rejects.toMatchObject({ category: "invalid_input" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("never publishes when durable append fails", async () => {
    const publish = vi.fn();
    const fixture = createFixture({ appendFailure: new Error("storage"), publish });

    await expect(fixture.gateway.undoChange(context, {
      commandId: "undo-command-a",
      documentId: "document-a",
      generation: 1,
    })).rejects.toBeInstanceOf(CollaborationGatewayError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("closes a live room when a durable update cannot be applied in memory", async () => {
    const fixture = createFixture({
      publish: async () => {
        throw new Error("live apply failed");
      },
    });

    await expect(fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-live-failure",
      documentId: "document-a",
      generation: 1,
    })).rejects.toMatchObject({ category: "live_apply_failed" });
    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g1",
      "room_rotated",
    );
  });

  it("closes both source and target rooms when rotated-generation publish fails", async () => {
    const fixture = createFixture({
      publish: async () => {
        throw new Error("live apply failed");
      },
      receiptGeneration: 2,
    });

    await expect(fixture.gateway.applyProposal(context, {
      commandId: "proposal-command-rotated-live-failure",
      documentId: "document-a",
      generation: 1,
    })).rejects.toMatchObject({ category: "live_apply_failed" });
    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g1",
      "room_rotated",
    );
    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g2",
      "room_rotated",
    );
  });

  it("replays the exact durable update after live delivery fails without replanning", async () => {
    const published: Uint8Array[] = [];
    let publishAttempts = 0;
    const fixture = createFixture({
      persistReplay: true,
      publish: async (_scope, _documentId, _generation, update) => {
        published.push(Uint8Array.from(update));
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("temporary live failure");
      },
      receiptGeneration: 2,
    });
    const command = {
      commandId: "proposal-command-durable-replay",
      documentId: "document-a",
      generation: 1,
    };

    await expect(fixture.gateway.applyProposal(context, command)).rejects.toMatchObject({
      category: "live_apply_failed",
    });
    const result = await fixture.gateway.applyProposal(context, command);

    expect(result).toMatchObject({
      checksum: "b".repeat(64),
      generation: 2,
      headSeq: 1,
      status: "applied",
    });
    expect(fixture.planProposal).toHaveBeenCalledTimes(1);
    expect(fixture.appendValidatedUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.durableApplications).toBe(1);
    expect(fixture.canonical.getText("test").toString()).toBe("base proposal");
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g1",
      "room_rotated",
    );
  });

  it("closes the exact current room through the sidecar adapter", async () => {
    const fixture = createFixture();

    await fixture.gateway.closeRoom(scope, "document-a", "archived");

    expect(fixture.closeRoom).toHaveBeenCalledWith(
      "collab:v1:workspace-a:document-a:g1",
      "archived",
    );
  });
});

function createFixture(options: {
  appendFailure?: Error;
  events?: string[];
  publish?: (
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
    update: Uint8Array,
  ) => void | Promise<void>;
  publishWorkflowChanged?: (
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
  ) => void | Promise<void>;
  persistReplay?: boolean;
  receiptGeneration?: number;
  workflowChanged?: boolean;
} = {}) {
  const canonical = new Y.Doc();
  canonical.getText("test").insert(0, "base");
  const appended: Parameters<CollaborationPersistence["appendValidatedUpdate"]>[1][] = [];
  const snapshot = (): CollaborationSnapshot => ({
    checkpointSeq: 0,
    document: clone(canonical),
    documentId: "document-a",
    generation: 1,
    headSeq: 0,
    projectedSeq: 0,
    schemaFingerprint: "a".repeat(64),
    schemaVersion: 1,
  });
  let replay: {
    receipt: {
      checksum: string;
      documentId: string;
      generation: number;
      headSeq: number;
      seq: number;
      workflowChanged: boolean;
    };
    update: Uint8Array;
  } | null = null;
  let durableApplications = 0;
  const appendValidatedUpdate = vi.fn(async (_scope: WorkspaceScope, input: Parameters<CollaborationPersistence["appendValidatedUpdate"]>[1]) => {
      options.events?.push("append");
      appended.push(input);
      if (options.appendFailure) throw options.appendFailure;
      const receipt = {
        checksum: "b".repeat(64),
        documentId: input.documentId,
        generation: options.receiptGeneration ?? input.generation,
        headSeq: 1,
        seq: 1,
        workflowChanged: options.workflowChanged ?? false,
      };
      if (options.persistReplay) {
        replay = { receipt, update: Uint8Array.from(input.update) };
        Y.applyUpdate(canonical, input.update);
        durableApplications += 1;
      }
      return receipt;
    });
  const persistence = {
    appendValidatedUpdate,
    async findDurableUpdateReplay() {
      return replay;
    },
    async load() {
      return snapshot();
    },
  };
  const publish: NonNullable<typeof options.publish> = options.publish ?? vi.fn(async () => {
    options.events?.push("publish");
  });
  const closeRoom = vi.fn(async (room: string) => {
    options.events?.push(`close:${room}`);
  });
  const publishWorkflowChanged = vi.fn(options.publishWorkflowChanged ?? (async () => {
    options.events?.push("workflow");
  }));
  const planProposal = vi.fn(async (document: Y.Doc) => {
    options.events?.push("plan");
    document.getText("test").insert(document.getText("test").length, " proposal");
  });
  const gateway = createCollaborativeDocumentGateway({
    closeRoom,
    persistence,
    planners: {
      proposal: planProposal,
      async proposalBatch(document) {
        document.getText("test").insert(document.getText("test").length, " batch");
      },
      async undo(document) {
        document.getText("test").delete(0, document.getText("test").length);
      },
    },
    publish,
    publishWorkflowChanged,
  });
  return {
    appendValidatedUpdate,
    appended,
    canonical,
    closeRoom,
    get durableApplications() {
      return durableApplications;
    },
    gateway,
    planProposal,
    publish,
    publishWorkflowChanged,
  };
}

function clone(document: Y.Doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(document));
  return result;
}
