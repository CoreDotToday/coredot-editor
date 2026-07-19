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
  receiptGeneration?: number;
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
  const persistence = {
    async appendValidatedUpdate(_scope, input) {
      options.events?.push("append");
      appended.push(input);
      if (options.appendFailure) throw options.appendFailure;
      return {
        checksum: "b".repeat(64),
        documentId: input.documentId,
        generation: options.receiptGeneration ?? input.generation,
        headSeq: 1,
        seq: 1,
      };
    },
    async load() {
      return snapshot();
    },
  } satisfies Pick<CollaborationPersistence, "appendValidatedUpdate" | "load">;
  const publish: NonNullable<typeof options.publish> = options.publish ?? vi.fn(async () => {
    options.events?.push("publish");
  });
  const closeRoom = vi.fn(async (room: string) => {
    options.events?.push(`close:${room}`);
  });
  const gateway = createCollaborativeDocumentGateway({
    closeRoom,
    persistence,
    planners: {
      async proposal(document) {
        options.events?.push("plan");
        document.getText("test").insert(document.getText("test").length, " proposal");
      },
      async proposalBatch(document) {
        document.getText("test").insert(document.getText("test").length, " batch");
      },
      async undo(document) {
        document.getText("test").delete(0, document.getText("test").length);
      },
    },
    publish,
  });
  return { appended, canonical, closeRoom, gateway, publish };
}

function clone(document: Y.Doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(document));
  return result;
}
