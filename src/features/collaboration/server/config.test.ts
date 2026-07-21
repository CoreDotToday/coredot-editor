import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import {
  COLLABORATION_LIMITS,
  CollaborationServerConfigurationError,
  readCollaborationServerConfig,
} from "./config";

describe("collaboration sidecar configuration", () => {
  it("pins the reviewed resource limits", () => {
    expect(COLLABORATION_LIMITS).toEqual({
      awarenessBytes: 4 * 1024,
      maxConnectionsPerPrincipal: 5,
      maxConnectionsPerRoom: 50,
      maxConnectionsPerWorkspace: 200,
      maxLoadedDocumentBytes: 64 * 1024 * 1024,
      maxLoadedDocuments: 64,
      maxPendingDocuments: 4,
      maxUnauthenticatedQueueMessages: 32,
      maxUnauthenticatedQueueSize: 256 * 1024,
      updateBytesPerWindow: 2 * 1024 * 1024,
      updateMessagesPerWindow: 120,
      updateWindowMs: 1_000,
      websocketPayloadBytes: 512 * 1024,
    });
  });

  it("loads only a public verifier ring and bounded network settings", async () => {
    const verifier = await verificationRingJson();
    expect(readCollaborationServerConfig({
      COLLABORATION_ALLOWED_HOSTS: "collab.example.test,127.0.0.1",
      COLLABORATION_ALLOWED_ORIGINS: "https://editor.example.test,http://127.0.0.1:3000",
      COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: verifier,
      COLLABORATION_SERVER_ADDRESS: "127.0.0.1",
      COLLABORATION_SERVER_PORT: "0",
      COLLABORATION_SHUTDOWN_GRACE_MS: "5000",
    })).toMatchObject({
      address: "127.0.0.1",
      allowedHosts: ["collab.example.test", "127.0.0.1"],
      allowedOrigins: ["https://editor.example.test", "http://127.0.0.1:3000"],
      port: 0,
      shutdownGraceMs: 5_000,
    });
  });

  it.each([
    ["private signer material", { COLLABORATION_CAPABILITY_SIGNING_KEY_RING: "secret" }],
    ["wildcard origin", { COLLABORATION_ALLOWED_ORIGINS: "*" }],
    ["origin path", { COLLABORATION_ALLOWED_ORIGINS: "https://editor.example.test/path" }],
    ["host with a path", { COLLABORATION_ALLOWED_HOSTS: "example.test/path" }],
    ["unbounded port", { COLLABORATION_SERVER_PORT: "65536" }],
    ["unbounded grace", { COLLABORATION_SHUTDOWN_GRACE_MS: "60001" }],
  ] as const)("fails closed for %s without echoing configuration", async (_name, override) => {
    const verifier = await verificationRingJson();
    expect(() => readCollaborationServerConfig({
      COLLABORATION_ALLOWED_HOSTS: "collab.example.test",
      COLLABORATION_ALLOWED_ORIGINS: "https://editor.example.test",
      COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING: verifier,
      ...override,
    })).toThrow(new CollaborationServerConfigurationError());
  });
});

async function verificationRingJson() {
  const { publicKey } = await generateKeyPair("ES256", { extractable: true });
  return JSON.stringify({
    keys: [{ alg: "ES256", kid: "server-test", publicJwk: await exportJWK(publicKey) }],
  });
}
