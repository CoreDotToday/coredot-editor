import { createHmac, timingSafeEqual } from "node:crypto";

import type { RequestContext } from "./request-context";

const DEFAULT_TEST_PRINCIPAL_ID = "test:principal:local";
const DEFAULT_TEST_WORKSPACE_ID = "test:workspace:local";
const MAX_TEST_IDENTITY_HEADER_BYTES = 2_048;
const MAX_TEST_IDENTITY_LIFETIME_SECONDS = 60;
const MIN_TEST_IDENTITY_SECRET_BYTES = 32;
const MAX_IDENTITY_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BOUNDARY_WHITESPACE = /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/;

export const TEST_IDENTITY_HEADER = "X-Coredot-Test-Identity";

export class TestIdentityOverrideError extends Error {
  override readonly name = "TestIdentityOverrideError";
  constructor() {
    super("Test identity override is invalid");
  }
}

type HeaderReader = Pick<Headers, "get">;
type TestIdentityPayload = {
  exp: number;
  principalId: string;
  workspaceId: string;
};

type TestRequestContextOptions = {
  headers?: HeaderReader;
  now?: Date;
};

export function createTestRequestContext(
  env: NodeJS.ProcessEnv = process.env,
  options: TestRequestContextOptions = {},
): RequestContext {
  const override = resolveSignedIdentityOverride(env, options);
  return {
    authMode: "test",
    principalId: override?.principalId ?? (env.TEST_PRINCIPAL_ID || DEFAULT_TEST_PRINCIPAL_ID),
    requestId: crypto.randomUUID(),
    role: "owner",
    workspaceId: override?.workspaceId ?? (env.TEST_WORKSPACE_ID || DEFAULT_TEST_WORKSPACE_ID),
  };
}

export function createSignedTestIdentityHeader(
  identity: { expiresAt: Date; principalId: string; workspaceId: string },
  secret: string,
) {
  assertSecret(secret);
  assertIdentity(identity.principalId);
  assertIdentity(identity.workspaceId);
  const exp = Math.floor(identity.expiresAt.getTime() / 1_000);
  if (!Number.isSafeInteger(exp) || exp <= 0) throw invalidOverride();
  const encodedPayload = Buffer.from(JSON.stringify({
    exp,
    principalId: identity.principalId,
    workspaceId: identity.workspaceId,
  } satisfies TestIdentityPayload)).toString("base64url");
  const signature = sign(encodedPayload, secret).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

function resolveSignedIdentityOverride(
  env: NodeJS.ProcessEnv,
  options: TestRequestContextOptions,
): TestIdentityPayload | null {
  const header = options.headers?.get(TEST_IDENTITY_HEADER);
  const secret = env.TEST_IDENTITY_SIGNING_SECRET?.trim();
  if (!header || !secret) return null;
  if (env.NODE_ENV === "production" || env.AUTH_MODE !== "test") throw invalidOverride();
  assertSecret(secret);
  if (Buffer.byteLength(header, "utf8") > MAX_TEST_IDENTITY_HEADER_BYTES) throw invalidOverride();
  const segments = header.split(".");
  if (segments.length !== 2) throw invalidOverride();
  const [encodedPayload, encodedSignature] = segments;
  if (!isCanonicalBase64Url(encodedPayload!) || !isCanonicalBase64Url(encodedSignature!)) {
    throw invalidOverride();
  }
  const suppliedSignature = Buffer.from(encodedSignature!, "base64url");
  const expectedSignature = sign(encodedPayload!, secret);
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw invalidOverride();
  }
  let payload: unknown;
  try {
    const decodedPayload = Buffer.from(encodedPayload!, "base64url").toString("utf8");
    payload = JSON.parse(decodedPayload);
    if (isTestIdentityPayload(payload)) {
      const canonical = JSON.stringify({
        exp: payload.exp,
        principalId: payload.principalId,
        workspaceId: payload.workspaceId,
      } satisfies TestIdentityPayload);
      if (decodedPayload !== canonical) throw invalidOverride();
    }
  } catch {
    throw invalidOverride();
  }
  if (!isTestIdentityPayload(payload)) throw invalidOverride();
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if (
    payload.exp <= nowSeconds
    || payload.exp > nowSeconds + MAX_TEST_IDENTITY_LIFETIME_SECONDS
  ) {
    throw invalidOverride();
  }
  return payload;
}

function isTestIdentityPayload(value: unknown): value is TestIdentityPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join(",") !== "exp,principalId,workspaceId") return false;
  if (!Number.isSafeInteger(record.exp) || typeof record.exp !== "number") return false;
  try {
    assertIdentity(record.principalId);
    assertIdentity(record.workspaceId);
    return true;
  } catch {
    return false;
  }
}

function assertIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > MAX_IDENTITY_BYTES
    || BOUNDARY_WHITESPACE.test(value)
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidOverride();
  }
}

function assertSecret(secret: string) {
  if (Buffer.byteLength(secret, "utf8") < MIN_TEST_IDENTITY_SECRET_BYTES) throw invalidOverride();
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function isCanonicalBase64Url(value: string) {
  return value.length > 0
    && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

function invalidOverride() {
  return new TestIdentityOverrideError();
}
