import { describe, expect, it } from "vitest";

import {
  CollaborationResourceLimitError,
  createCollaborationResourceRegistry,
} from "./resource-limits";

const context = (overrides: Partial<{
  principalId: string;
  room: string;
  workspaceId: string;
}> = {}) => ({
  principalId: "principal:1",
  room: "room:1",
  workspaceId: "workspace:1",
  ...overrides,
});

describe("collaboration resource registry", () => {
  it("caps workspace, principal, and room connections and releases every counter", () => {
    const resources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 20,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 20,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });
    const first = resources.reserveConnection("socket:1", context());
    const second = resources.reserveConnection("socket:2", context({
      principalId: "principal:2",
      room: "room:2",
    }));

    expect(() => resources.reserveConnection("socket:3", context({
      principalId: "principal:3",
      room: "room:3",
    }))).toThrow(new CollaborationResourceLimitError("connection_limit"));

    resources.releaseConnection(first);
    expect(() => resources.reserveConnection("socket:3", context({
      principalId: "principal:3",
      room: "room:3",
    }))).not.toThrow();
    resources.releaseConnection(second);

    const principalResources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 1,
      maxConnectionsPerRoom: 10,
      maxConnectionsPerWorkspace: 10,
      maxLoadedDocumentBytes: 20,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 20,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });
    principalResources.reserveConnection("socket:p1", context({ room: "room:p1" }));
    expect(() => principalResources.reserveConnection(
      "socket:p2",
      context({ room: "room:p2" }),
    )).toThrow(new CollaborationResourceLimitError("connection_limit"));

    const roomResources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 10,
      maxConnectionsPerRoom: 1,
      maxConnectionsPerWorkspace: 10,
      maxLoadedDocumentBytes: 20,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 20,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });
    roomResources.reserveConnection("socket:r1", context());
    expect(() => roomResources.reserveConnection(
      "socket:r2",
      context({ principalId: "principal:2" }),
    )).toThrow(new CollaborationResourceLimitError("connection_limit"));
  });

  it("bounds both update messages and aggregate bytes in a time window", () => {
    let now = 10_000;
    const resources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 20,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 100,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    }, () => now);
    const connection = {};

    resources.consumeUpdate(connection, 1);
    resources.consumeUpdate(connection, 1);
    expect(() => resources.consumeUpdate(connection, 1)).toThrow(
      new CollaborationResourceLimitError("update_limit"),
    );

    now += 1_000;
    expect(() => resources.consumeUpdate(connection, 10)).not.toThrow();

    const byteResources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 20,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 10,
      updateMessagesPerWindow: 100,
      updateWindowMs: 1_000,
    }, () => now);
    byteResources.consumeUpdate(connection, 4);
    byteResources.consumeUpdate(connection, 6);
    expect(() => byteResources.consumeUpdate(connection, 1)).toThrow(
      new CollaborationResourceLimitError("update_limit"),
    );
  });

  it("caps loaded document count independently and releases count on unload", () => {
    const resources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 100,
      maxLoadedDocuments: 2,
      updateBytesPerWindow: 10,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });

    resources.reserveDocument("room:1", 40);
    resources.reserveDocument("room:2", 40);
    expect(() => resources.reserveDocument("room:3", 1)).toThrow(
      new CollaborationResourceLimitError("document_limit"),
    );
    resources.releaseDocument("room:1");
    expect(() => resources.reserveDocument("room:3", 40)).not.toThrow();
  });

  it("reserves conservative update growth, rolls failures back, and commits successes", () => {
    const resources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 10,
      maxLoadedDocuments: 4,
      updateBytesPerWindow: 10,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });
    resources.reserveDocument("room:1", 4);
    resources.reserveDocument("room:2", 4);

    const failedAppend = resources.reserveDocumentGrowth("room:1", 2);
    expect(() => resources.reserveDocumentGrowth("room:2", 1)).toThrow(
      new CollaborationResourceLimitError("document_limit"),
    );
    failedAppend.rollback();

    const successfulAppend = resources.reserveDocumentGrowth("room:2", 2);
    successfulAppend.commit();
    expect(() => resources.reserveDocumentGrowth("room:1", 1)).toThrow(
      new CollaborationResourceLimitError("document_limit"),
    );
    resources.releaseDocument("room:2");
    expect(() => resources.reserveDocumentGrowth("room:1", 1)).not.toThrow();
  });

  it("does not let an old append rollback mutate a reloaded room incarnation", () => {
    const resources = createCollaborationResourceRegistry({
      maxConnectionsPerPrincipal: 2,
      maxConnectionsPerRoom: 2,
      maxConnectionsPerWorkspace: 2,
      maxLoadedDocumentBytes: 10,
      maxLoadedDocuments: 4,
      updateBytesPerWindow: 10,
      updateMessagesPerWindow: 2,
      updateWindowMs: 1_000,
    });
    resources.reserveDocument("room:1", 4);
    const oldAppend = resources.reserveDocumentGrowth("room:1", 2);
    resources.releaseDocument("room:1");
    resources.reserveDocument("room:1", 9);

    oldAppend.rollback();

    expect(() => resources.reserveDocumentGrowth("room:1", 2)).toThrow(
      new CollaborationResourceLimitError("document_limit"),
    );
  });
});
