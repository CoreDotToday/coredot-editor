import { randomUUID } from "node:crypto";

import {
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import { parseCollaborationRoomName } from "./room-name";

const ISSUER = "coredot-editor" as const;
const AUDIENCE = "coredot-collaboration" as const;
const MAX_LIFETIME_SECONDS = 60;
const MAX_KEY_RING_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_SESSION_BYTES = 128;
const MAX_ROOM_BYTES = 8 * 1024;
const MAX_NOT_BEFORE_SKEW_SECONDS = 5;
const ALGORITHMS = ["EdDSA", "ES256"] as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BOUNDARY_WHITESPACE = /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/;

const algorithmSchema = z.enum(ALGORITHMS);
const keyIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const signingKeySchema = z.object({
  alg: algorithmSchema,
  kid: keyIdSchema,
  privateJwk: z.record(z.string(), z.unknown()),
}).strict();
const verificationKeySchema = z.object({
  alg: algorithmSchema,
  kid: keyIdSchema,
  publicJwk: z.record(z.string(), z.unknown()),
}).strict();
const signingRingSchema = z.object({
  activeKid: keyIdSchema,
  keys: z.array(signingKeySchema).length(1),
}).strict();
const verificationRingSchema = z.object({
  keys: z.array(verificationKeySchema).min(1).max(16),
}).strict();

export type CollaborationCapabilityClaims = {
  aud: typeof AUDIENCE;
  authorizationEpoch: number;
  documentId: string;
  exp: number;
  iat: number;
  iss: typeof ISSUER;
  jti: string;
  nbf: number;
  permission: "read" | "write";
  principalId: string;
  room: string;
  sessionId: string;
  workspaceId: string;
};

export type CollaborationCapabilityBindings = Omit<
  CollaborationCapabilityClaims,
  "aud" | "exp" | "iat" | "iss" | "jti" | "nbf"
>;

export type CollaborationCapabilitySigningKeyRing = z.infer<typeof signingRingSchema>;
export type CollaborationCapabilityVerificationKeyRing = z.infer<typeof verificationRingSchema>;

export class CollaborationCapabilityError extends Error {
  override readonly name = "CollaborationCapabilityError";
  constructor() {
    super("Collaboration capability is invalid");
  }
}

export class CollaborationCapabilityConfigurationError extends Error {
  override readonly name = "CollaborationCapabilityConfigurationError";
  constructor() {
    super("Collaboration capability key ring is invalid");
  }
}

export function parseCollaborationCapabilitySigningKeyRing(
  input: string | unknown,
): CollaborationCapabilitySigningKeyRing {
  const parsed = parseRingInput(input);
  const result = signingRingSchema.safeParse(parsed);
  if (!result.success || hasDuplicateKids(result.data.keys)) throw configurationError();
  const active = result.data.keys.find((key) => key.kid === result.data.activeKid);
  if (!active || !isPrivateJwkForAlgorithm(active.privateJwk, active.alg)) {
    throw configurationError();
  }
  for (const key of result.data.keys) {
    if (!isPrivateJwkForAlgorithm(key.privateJwk, key.alg)) throw configurationError();
  }
  return result.data;
}

export function parseCollaborationCapabilityVerificationKeyRing(
  input: string | unknown,
): CollaborationCapabilityVerificationKeyRing {
  const parsed = parseRingInput(input);
  const result = verificationRingSchema.safeParse(parsed);
  if (!result.success || hasDuplicateKids(result.data.keys)) throw configurationError();
  for (const key of result.data.keys) {
    if (!isPublicJwkForAlgorithm(key.publicJwk, key.alg)) throw configurationError();
  }
  return result.data;
}

export function readCollaborationCapabilitySigningKeyRing(
  env: NodeJS.ProcessEnv = process.env,
) {
  return parseCollaborationCapabilitySigningKeyRing(
    env.COLLABORATION_CAPABILITY_SIGNING_KEY_RING,
  );
}

export function readCollaborationCapabilityVerificationKeyRing(
  env: NodeJS.ProcessEnv = process.env,
) {
  return parseCollaborationCapabilityVerificationKeyRing(
    env.COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING,
  );
}

export function createCollaborationCapabilityAuthority(options: {
  now?: () => Date;
  signingKeyRing?: CollaborationCapabilitySigningKeyRing;
  verificationKeyRing?: CollaborationCapabilityVerificationKeyRing;
}) {
  const now = options.now ?? (() => new Date());
  return {
    async issue(bindings: CollaborationCapabilityBindings) {
      const normalized = normalizeBindings(bindings);
      const ring = options.signingKeyRing;
      if (!ring) throw configurationError();
      const entry = ring.keys.find((key) => key.kid === ring.activeKid);
      if (!entry) throw configurationError();
      const issuedAt = Math.floor(now().getTime() / 1_000);
      try {
        const key = await importJWK(entry.privateJwk as JWK, entry.alg);
        return await new SignJWT({
          authorizationEpoch: normalized.authorizationEpoch,
          documentId: normalized.documentId,
          permission: normalized.permission,
          principalId: normalized.principalId,
          room: normalized.room,
          sessionId: normalized.sessionId,
          workspaceId: normalized.workspaceId,
        })
          .setProtectedHeader({ alg: entry.alg, kid: entry.kid, typ: "JWT" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setJti(randomUUID())
          .setIssuedAt(issuedAt)
          .setNotBefore(issuedAt - 1)
          .setExpirationTime(issuedAt + MAX_LIFETIME_SECONDS)
          .sign(key);
      } catch (error) {
        if (error instanceof CollaborationCapabilityError) throw error;
        throw configurationError();
      }
    },

    async verify(token: string, expected: CollaborationCapabilityBindings) {
      try {
        const normalizedExpected = normalizeBindings(expected);
        if (
          typeof token !== "string"
          || Buffer.byteLength(token, "utf8") < 1
          || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
        ) {
          throw invalidCapability();
        }
        const segments = token.split(".");
        if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
          throw invalidCapability();
        }
        const protectedHeader = JSON.parse(
          Buffer.from(segments[0]!, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        if (
          Object.keys(protectedHeader).toSorted().join(",") !== "alg,kid,typ"
          || !ALGORITHMS.includes(protectedHeader.alg as (typeof ALGORITHMS)[number])
          || typeof protectedHeader.kid !== "string"
          || protectedHeader.typ !== "JWT"
        ) {
          throw invalidCapability();
        }
        const entry = options.verificationKeyRing?.keys.find(
          (key) => key.kid === protectedHeader.kid && key.alg === protectedHeader.alg,
        );
        if (!entry) throw invalidCapability();
        const key = await importJWK(entry.publicJwk as JWK, entry.alg);
        const result = await jwtVerify(token, key, {
          algorithms: [entry.alg],
          audience: AUDIENCE,
          clockTolerance: 0,
          currentDate: now(),
          issuer: ISSUER,
        });
        const claims = normalizeClaims(result.payload, now());
        assertExactBindings(claims, normalizedExpected);
        return claims;
      } catch {
        throw invalidCapability();
      }
    },
  };
}

function normalizeClaims(payload: JWTPayload, currentDate: Date): CollaborationCapabilityClaims {
  const expectedKeys = [
    "aud",
    "authorizationEpoch",
    "documentId",
    "exp",
    "iat",
    "iss",
    "jti",
    "nbf",
    "permission",
    "principalId",
    "room",
    "sessionId",
    "workspaceId",
  ];
  if (Object.keys(payload).toSorted().join(",") !== expectedKeys.toSorted().join(",")) {
    throw invalidCapability();
  }
  if (
    payload.aud !== AUDIENCE
    || payload.iss !== ISSUER
    || typeof payload.jti !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.jti)
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.nbf)
    || !Number.isSafeInteger(payload.exp)
  ) {
    throw invalidCapability();
  }
  const iat = payload.iat!;
  const nbf = payload.nbf!;
  const exp = payload.exp!;
  const currentSeconds = Math.floor(currentDate.getTime() / 1_000);
  if (
    nbf > iat
    || iat > currentSeconds
    || iat - nbf > MAX_NOT_BEFORE_SKEW_SECONDS
    || exp <= iat
    || exp - iat > MAX_LIFETIME_SECONDS
  ) {
    throw invalidCapability();
  }
  const bindings = normalizeBindings({
    authorizationEpoch: payload.authorizationEpoch,
    documentId: payload.documentId,
    permission: payload.permission,
    principalId: payload.principalId,
    room: payload.room,
    sessionId: payload.sessionId,
    workspaceId: payload.workspaceId,
  });
  return { aud: AUDIENCE, exp, iat, iss: ISSUER, jti: payload.jti, nbf, ...bindings };
}

function normalizeBindings(input: Record<string, unknown>): CollaborationCapabilityBindings {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).toSorted().join(",")
      !== "authorizationEpoch,documentId,permission,principalId,room,sessionId,workspaceId"
  ) {
    throw invalidCapability();
  }
  const authorizationEpoch = input.authorizationEpoch;
  const permission = input.permission;
  if (!Number.isSafeInteger(authorizationEpoch) || (authorizationEpoch as number) < 0) {
    throw invalidCapability();
  }
  if (permission !== "read" && permission !== "write") throw invalidCapability();
  const workspaceId = normalizeIdentifier(input.workspaceId, MAX_IDENTIFIER_BYTES);
  const documentId = normalizeIdentifier(input.documentId, MAX_IDENTIFIER_BYTES);
  const principalId = normalizeIdentifier(input.principalId, MAX_IDENTIFIER_BYTES);
  const sessionId = normalizeIdentifier(input.sessionId, MAX_SESSION_BYTES);
  if (!isUuid(sessionId)) throw invalidCapability();
  const room = normalizeIdentifier(input.room, MAX_ROOM_BYTES);
  let roomIdentity: ReturnType<typeof parseCollaborationRoomName>;
  try {
    roomIdentity = parseCollaborationRoomName(room);
  } catch {
    throw invalidCapability();
  }
  if (roomIdentity.workspaceId !== workspaceId || roomIdentity.documentId !== documentId) {
    throw invalidCapability();
  }
  return {
    authorizationEpoch: authorizationEpoch as number,
    documentId,
    permission,
    principalId,
    room,
    sessionId,
    workspaceId,
  };
}

function normalizeIdentifier(value: unknown, maximumBytes: number) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || CONTROL_CHARACTERS.test(value)
    || BOUNDARY_WHITESPACE.test(value)
  ) {
    throw invalidCapability();
  }
  return value;
}

function assertExactBindings(
  claims: CollaborationCapabilityClaims,
  expected: CollaborationCapabilityBindings,
) {
  for (const key of Object.keys(expected) as Array<keyof CollaborationCapabilityBindings>) {
    if (claims[key] !== expected[key]) throw invalidCapability();
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRingInput(input: string | unknown) {
  try {
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > MAX_KEY_RING_BYTES) throw configurationError();
      return JSON.parse(input) as unknown;
    }
    const encoded = JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_KEY_RING_BYTES) {
      throw configurationError();
    }
    return input;
  } catch {
    throw configurationError();
  }
}

function hasDuplicateKids(keys: Array<{ kid: string }>) {
  return new Set(keys.map((key) => key.kid)).size !== keys.length;
}

function isPrivateJwkForAlgorithm(jwk: Record<string, unknown>, alg: string) {
  return typeof jwk.d === "string"
    && jwk.d.length > 0
    && (jwk.alg === undefined || jwk.alg === alg)
    && (
      (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256"
        && typeof jwk.x === "string" && typeof jwk.y === "string")
      || (alg === "EdDSA" && jwk.kty === "OKP" && jwk.crv === "Ed25519"
        && typeof jwk.x === "string")
    );
}

function isPublicJwkForAlgorithm(jwk: Record<string, unknown>, alg: string) {
  return jwk.d === undefined
    && (jwk.alg === undefined || jwk.alg === alg)
    && (
      (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256"
        && typeof jwk.x === "string" && typeof jwk.y === "string")
      || (alg === "EdDSA" && jwk.kty === "OKP" && jwk.crv === "Ed25519"
        && typeof jwk.x === "string")
    );
}

function configurationError() {
  return new CollaborationCapabilityConfigurationError();
}

function invalidCapability() {
  return new CollaborationCapabilityError();
}
