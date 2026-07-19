import { isIP } from "node:net";

import {
  parseCollaborationCapabilityVerificationKeyRing,
  type CollaborationCapabilityVerificationKeyRing,
} from "../capability";

export const COLLABORATION_LIMITS = Object.freeze({
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

export type CollaborationServerConfig = {
  address: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  port: number;
  shutdownGraceMs: number;
  verificationKeyRing: CollaborationCapabilityVerificationKeyRing;
};

export class CollaborationServerConfigurationError extends Error {
  override readonly name = "CollaborationServerConfigurationError";

  constructor() {
    super("Collaboration sidecar configuration is invalid");
  }
}

export function readCollaborationServerConfig(
  env: Record<string, string | undefined> = process.env,
): CollaborationServerConfig {
  try {
    if (env.COLLABORATION_CAPABILITY_SIGNING_KEY_RING?.trim()) throw invalidConfig();
    const address = normalizeAddress(env.COLLABORATION_SERVER_ADDRESS ?? "127.0.0.1");
    const port = normalizeInteger(env.COLLABORATION_SERVER_PORT ?? "1234", 0, 65_535);
    const shutdownGraceMs = normalizeInteger(
      env.COLLABORATION_SHUTDOWN_GRACE_MS ?? "10000",
      1_000,
      60_000,
    );
    const allowedHosts = normalizeList(
      env.COLLABORATION_ALLOWED_HOSTS,
      normalizeHost,
    );
    const allowedOrigins = normalizeList(
      env.COLLABORATION_ALLOWED_ORIGINS,
      normalizeOrigin,
    );
    const verificationKeyRing = parseCollaborationCapabilityVerificationKeyRing(
      env.COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING,
    );
    return {
      address,
      allowedHosts,
      allowedOrigins,
      port,
      shutdownGraceMs,
      verificationKeyRing,
    };
  } catch {
    throw invalidConfig();
  }
}

function normalizeAddress(value: string) {
  const address = value.trim();
  if (
    address !== value
    || address.length < 1
    || address.length > 255
    || (!isIP(address) && address !== "localhost")
  ) {
    throw invalidConfig();
  }
  return address;
}

function normalizeInteger(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value)) throw invalidConfig();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidConfig();
  }
  return parsed;
}

function normalizeList(
  value: string | undefined,
  normalize: (entry: string) => string,
) {
  if (!value || Buffer.byteLength(value, "utf8") > 8 * 1024) throw invalidConfig();
  const entries = value.split(",").map(normalize);
  if (
    entries.length < 1
    || entries.length > 32
    || new Set(entries).size !== entries.length
  ) {
    throw invalidConfig();
  }
  return entries;
}

function normalizeHost(value: string) {
  if (
    value.length < 1
    || value.length > 255
    || value !== value.trim()
    || value === "*"
    || /[\s/?#@]/.test(value)
  ) {
    throw invalidConfig();
  }
  try {
    const url = new URL(`http://${value}`);
    if (url.hostname !== value && `[${url.hostname}]` !== value) throw invalidConfig();
    return value.toLowerCase();
  } catch {
    throw invalidConfig();
  }
}

function normalizeOrigin(value: string) {
  if (value.length < 1 || value.length > 2_048 || value !== value.trim()) {
    throw invalidConfig();
  }
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value
  ) {
    throw invalidConfig();
  }
  return url.origin;
}

function invalidConfig() {
  return new CollaborationServerConfigurationError();
}
