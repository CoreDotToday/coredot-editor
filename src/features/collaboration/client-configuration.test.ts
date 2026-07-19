import { describe, expect, it, vi } from "vitest";

import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";

import {
  resolveCollaborationClientConfiguration,
  type CollaborationClientConfigurationDependencies,
} from "./client-configuration";

const snapshot = {
  documentId: "document-a",
  generation: 3,
  schemaFingerprint: "a".repeat(64),
};

describe("collaboration client configuration", () => {
  it("keeps disabled deployments on the legacy editor without reading collaboration storage", async () => {
    const dependencies = createDependencies();

    await expect(resolveCollaborationClientConfiguration(
      TEST_REQUEST_CONTEXT,
      "document-a",
      { COLLABORATION_MODE: "disabled" },
      dependencies,
    )).resolves.toEqual({ kind: "legacy" });

    expect(dependencies.loadIdentity).not.toHaveBeenCalled();
  });

  it("opens only initialized documents in self-hosted collaboration mode", async () => {
    const dependencies = createDependencies();

    await expect(resolveCollaborationClientConfiguration(
      TEST_REQUEST_CONTEXT,
      "document-a",
      {
        COLLABORATION_MODE: "self-hosted",
        COLLABORATION_WEBSOCKET_URL: "wss://collaboration.example.test/",
      },
      dependencies,
    )).resolves.toEqual({
      documentId: "document-a",
      kind: "collaboration",
      room: "collab:v1:vitest-workspace:document-a:g3",
      schemaFingerprint: "a".repeat(64),
      websocketUrl: "wss://collaboration.example.test/",
    });

    expect(dependencies.loadIdentity).toHaveBeenCalledWith(
      { workspaceId: TEST_REQUEST_CONTEXT.workspaceId },
      "document-a",
    );
  });

  it("preserves legacy mode for a self-hosted document that has not initialized collaboration", async () => {
    const dependencies = createDependencies({ loadIdentity: vi.fn(async () => null) });

    await expect(resolveCollaborationClientConfiguration(
      TEST_REQUEST_CONTEXT,
      "document-a",
      {
        COLLABORATION_MODE: "self-hosted",
        COLLABORATION_WEBSOCKET_URL: "wss://collaboration.example.test/",
      },
      dependencies,
    )).resolves.toEqual({ kind: "legacy" });
  });

  it.each([
    ["missing URL", undefined],
    ["public HTTP URL", "https://collaboration.example.test/"],
    ["credentials", "wss://user:password@collaboration.example.test/"],
    ["query", "wss://collaboration.example.test/?token=secret"],
    ["fragment", "wss://collaboration.example.test/#secret"],
  ])("fails an initialized document closed as a read-only collaboration projection for %s", async (_label, url) => {
    const dependencies = createDependencies();

    await expect(resolveCollaborationClientConfiguration(
      TEST_REQUEST_CONTEXT,
      "document-a",
      {
        COLLABORATION_MODE: "self-hosted",
        COLLABORATION_WEBSOCKET_URL: url,
      },
      dependencies,
    )).resolves.toEqual({
      documentId: "document-a",
      kind: "collaboration",
      room: "collab:v1:vitest-workspace:document-a:g3",
      schemaFingerprint: "a".repeat(64),
      websocketUrl: null,
    });
  });

  it("rejects unknown deployment modes instead of silently enabling a writer", async () => {
    const dependencies = createDependencies();

    await expect(resolveCollaborationClientConfiguration(
      TEST_REQUEST_CONTEXT,
      "document-a",
      { COLLABORATION_MODE: "cloud" },
      dependencies,
    )).rejects.toThrow("Collaboration client configuration is invalid");
  });
});

function createDependencies(
  overrides: Partial<CollaborationClientConfigurationDependencies> = {},
): CollaborationClientConfigurationDependencies {
  return {
    loadIdentity: vi.fn(async () => snapshot),
    ...overrides,
  };
}
