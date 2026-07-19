// @vitest-environment node

import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "@/features/auth/request-context";

import {
  CollaborationCapabilityError,
  createCollaborationCapabilityAuthority,
  parseCollaborationCapabilitySigningKeyRing,
  parseCollaborationCapabilityVerificationKeyRing,
  type CollaborationCapabilitySigningKeyRing,
  type CollaborationCapabilityVerificationKeyRing,
} from "./capability";
import {
  CollaborationCapabilityServiceError,
  createCollaborationCapabilityService,
} from "./capability-service";

const now = new Date("2026-07-19T09:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);
const context: RequestContext = {
  authMode: "clerk",
  principalId: "clerk:user:user-a",
  requestId: "request-a",
  role: "member",
  workspaceId: "clerk:org:workspace-a",
};
const room = "collab:v1:clerk%3Aorg%3Aworkspace-a:document-a:g3";
const sessionA = "22222222-2222-4222-8222-222222222222";
const sessionB = "33333333-3333-4333-8333-333333333333";

let signingKeyRing: CollaborationCapabilitySigningKeyRing;
let nextSigningKeyRing: CollaborationCapabilitySigningKeyRing;
let verificationKeyRing: CollaborationCapabilityVerificationKeyRing;
let rotatedVerificationKeyRing: CollaborationCapabilityVerificationKeyRing;
let activePrivateKey: CryptoKey;

beforeAll(async () => {
  const first = await generateKeyPair("ES256", { extractable: true });
  const second = await generateKeyPair("ES256", { extractable: true });
  activePrivateKey = first.privateKey;
  const firstPublicJwk = await exportJWK(first.publicKey);
  const firstPrivateJwk = await exportJWK(first.privateKey);
  const secondPublicJwk = await exportJWK(second.publicKey);
  const secondPrivateJwk = await exportJWK(second.privateKey);
  signingKeyRing = parseCollaborationCapabilitySigningKeyRing({
    activeKid: "2026-07-a",
    keys: [{
      alg: "ES256",
      kid: "2026-07-a",
      privateJwk: firstPrivateJwk,
    }],
  });
  verificationKeyRing = parseCollaborationCapabilityVerificationKeyRing({
    keys: [{ alg: "ES256", kid: "2026-07-a", publicJwk: firstPublicJwk }],
  });
  rotatedVerificationKeyRing = parseCollaborationCapabilityVerificationKeyRing({
    keys: [
      { alg: "ES256", kid: "2026-07-a", publicJwk: firstPublicJwk },
      { alg: "ES256", kid: "2026-07-b", publicJwk: secondPublicJwk },
    ],
  });
  // Prove the private key for a future rotation parses independently from the
  // public verifier ring distributed to the sidecar.
  nextSigningKeyRing = parseCollaborationCapabilitySigningKeyRing({
    activeKid: "2026-07-b",
    keys: [{ alg: "ES256", kid: "2026-07-b", privateJwk: secondPrivateJwk }],
  });
});

function expectedBindings() {
  return {
    authorizationEpoch: 7,
    documentId: "document-a",
    permission: "write" as const,
    principalId: context.principalId,
    room,
    sessionId: sessionA,
    workspaceId: context.workspaceId,
  };
}

describe("collaboration capability authority", () => {
  it("issues an asymmetric, kid-bound capability with every normalized claim and a maximum 60 second lifetime", async () => {
    const authority = createCollaborationCapabilityAuthority({
      now: () => now,
      signingKeyRing,
      verificationKeyRing,
    });

    const token = await authority.issue(expectedBindings());
    const claims = decodeJwt(token);

    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "2026-07-a", typ: "JWT" });
    expect(claims).toMatchObject({
      aud: "coredot-collaboration",
      authorizationEpoch: 7,
      documentId: "document-a",
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: "coredot-editor",
      nbf: nowSeconds - 1,
      permission: "write",
      principalId: context.principalId,
      room,
      sessionId: sessionA,
      workspaceId: context.workspaceId,
    });
    expect(claims.jti).toEqual(expect.any(String));
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(60);

    await expect(authority.verify(token, expectedBindings())).resolves.toEqual(claims);
  });

  it.each([
    ["room", "collab:v1:other:document-a:g3"],
    ["workspaceId", "workspace-b"],
    ["documentId", "document-b"],
    ["principalId", "principal-b"],
    ["sessionId", sessionB],
    ["permission", "read"],
    ["authorizationEpoch", 8],
  ] as const)("rejects an exact %s binding mismatch", async (property, value) => {
    const authority = createCollaborationCapabilityAuthority({
      now: () => now,
      signingKeyRing,
      verificationKeyRing,
    });
    const token = await authority.issue(expectedBindings());

    await expect(authority.verify(token, { ...expectedBindings(), [property]: value }))
      .rejects.toBeInstanceOf(CollaborationCapabilityError);
  });

  it("accepts a previous public verification key after signing-key rotation and rejects an unknown kid", async () => {
    const oldAuthority = createCollaborationCapabilityAuthority({
      now: () => now,
      signingKeyRing,
      verificationKeyRing,
    });
    const rotatedAuthority = createCollaborationCapabilityAuthority({
      now: () => now,
      verificationKeyRing: rotatedVerificationKeyRing,
    });
    const oldToken = await oldAuthority.issue(expectedBindings());
    const unknownKidToken = await signCustomToken({ kid: "unknown" });

    await expect(rotatedAuthority.verify(oldToken, expectedBindings())).resolves.toMatchObject({
      jti: expect.any(String),
    });
    await expect(rotatedAuthority.verify(unknownKidToken, expectedBindings()))
      .rejects.toBeInstanceOf(CollaborationCapabilityError);
  });

  it("supports overlap verification during rotation and rejects the retired kid after the overlap window", async () => {
    const oldSigner = createCollaborationCapabilityAuthority({ now: () => now, signingKeyRing });
    const newSigner = createCollaborationCapabilityAuthority({ now: () => now, signingKeyRing: nextSigningKeyRing });
    const overlapVerifier = createCollaborationCapabilityAuthority({
      now: () => now,
      verificationKeyRing: rotatedVerificationKeyRing,
    });
    const retiredVerifier = createCollaborationCapabilityAuthority({
      now: () => now,
      verificationKeyRing: {
        keys: [rotatedVerificationKeyRing.keys.find((key) => key.kid === "2026-07-b")!],
      },
    });
    const oldToken = await oldSigner.issue(expectedBindings());
    const newToken = await newSigner.issue(expectedBindings());

    await expect(overlapVerifier.verify(oldToken, expectedBindings())).resolves.toMatchObject({ jti: expect.any(String) });
    await expect(overlapVerifier.verify(newToken, expectedBindings())).resolves.toMatchObject({ jti: expect.any(String) });
    await expect(retiredVerifier.verify(oldToken, expectedBindings()))
      .rejects.toBeInstanceOf(CollaborationCapabilityError);
    await expect(retiredVerifier.verify(newToken, expectedBindings())).resolves.toMatchObject({ jti: expect.any(String) });
  });

  it.each([
    ["issuer", { iss: "other-editor" }],
    ["audience", { aud: "other-audience" }],
    ["not-before", { nbf: nowSeconds + 1 }],
    ["issued-at", { iat: nowSeconds + 1 }],
    ["overlong lifetime", { exp: nowSeconds + 61 }],
    ["reversed lifetime", { exp: nowSeconds }],
    ["not-before ordering", { iat: nowSeconds - 1, nbf: nowSeconds }],
    ["excessive not-before skew", { nbf: nowSeconds - 10 }],
    ["missing jti", { jti: undefined }],
    ["noncanonical jti", { jti: "not-a-uuid" }],
    ["noncanonical session", { sessionId: "client-session" }],
    ["overlong principal", { principalId: `principal-${"x".repeat(300)}` }],
  ] as const)("rejects an invalid %s without exposing token claims", async (_label, overrides) => {
    const authority = createCollaborationCapabilityAuthority({
      now: () => now,
      verificationKeyRing,
    });
    const token = await signCustomToken({}, overrides);

    const failure = await captureFailure(() => authority.verify(token, expectedBindings()));

    expect(failure).toBeInstanceOf(CollaborationCapabilityError);
    expect(failure.message).toBe("Collaboration capability is invalid");
    expect(failure.message.length).toBeLessThanOrEqual(120);
    expect(failure.message).not.toContain(token);
    expect(failure.message).not.toContain(context.principalId);
  });

  it("rejects algorithms outside the asymmetric allowlist and malformed key rings", async () => {
    expect(() => parseCollaborationCapabilitySigningKeyRing({
      activeKid: "symmetric",
      keys: [{ alg: "HS256", kid: "symmetric", privateJwk: {} }],
    })).toThrow("Collaboration capability key ring is invalid");
    expect(() => parseCollaborationCapabilityVerificationKeyRing("not-json"))
      .toThrow("Collaboration capability key ring is invalid");
    expect(() => parseCollaborationCapabilitySigningKeyRing({ activeKid: "missing", keys: [] }))
      .toThrow("Collaboration capability key ring is invalid");
    expect(() => parseCollaborationCapabilityVerificationKeyRing({
      keys: [{ alg: "ES256", kid: "public-leak", publicJwk: { d: "private" } }],
    })).toThrow("Collaboration capability key ring is invalid");
    expect(() => parseCollaborationCapabilityVerificationKeyRing({
      keys: [
        verificationKeyRing.keys[0],
        verificationKeyRing.keys[0],
      ],
    })).toThrow("Collaboration capability key ring is invalid");
    expect(() => parseCollaborationCapabilitySigningKeyRing({
      activeKid: "2026-07-a",
      keys: [signingKeyRing.keys[0], signingKeyRing.keys[0]],
    })).toThrow("Collaboration capability key ring is invalid");
  });

  it.each([
    ["non-JWT typ", { typ: "JOSE" }],
    ["algorithm/key confusion", { alg: "EdDSA" }],
  ])("rejects a tampered protected header: %s", async (_label, protectedHeader) => {
    const signer = createCollaborationCapabilityAuthority({ now: () => now, signingKeyRing });
    const verifier = createCollaborationCapabilityAuthority({ now: () => now, verificationKeyRing });
    const token = await signer.issue(expectedBindings());
    const tampered = tamperProtectedHeader(token, protectedHeader);

    await expect(verifier.verify(tampered, expectedBindings()))
      .rejects.toBeInstanceOf(CollaborationCapabilityError);
  });

  it("rejects an overlong token before parsing without reflecting it", async () => {
    const verifier = createCollaborationCapabilityAuthority({ now: () => now, verificationKeyRing });
    const token = `eyJhbGciOiJFUzI1NiJ9.${"a".repeat(20_000)}.signature`;

    const failure = await captureFailure(() => verifier.verify(token, expectedBindings()));

    expect(failure).toBeInstanceOf(CollaborationCapabilityError);
    expect(failure.message).not.toContain(token);
  });
});

describe("collaboration capability service", () => {
  it("initializes then rechecks current Workspace, draft status, generation, and authorization epoch before signing", async () => {
    const withAuthority = vi.fn(async (
      _scope: { workspaceId: string },
      _input: { documentId: string; principalId: string },
      operation: (current: { authorizationEpoch: number; generation: number }) => Promise<{
        expiresInSeconds: 60;
        room: string;
        token: string;
      }>,
    ) => operation({ authorizationEpoch: 7, generation: 3 }));
    const issue = vi.fn(async () => "signed-capability");
    const prepareIssue = vi.fn(async () => issue);
    const service = createCollaborationCapabilityService({
      generateSessionId: () => sessionA,
      prepareIssue,
      withAuthority,
    });

    await expect(service.issue(context, { documentId: "document-a" }))
      .resolves.toEqual({ expiresInSeconds: 60, room, token: "signed-capability" });
    expect(withAuthority).toHaveBeenCalledWith(
      { workspaceId: context.workspaceId },
      { documentId: "document-a", principalId: context.principalId },
      expect.any(Function),
    );
    expect(prepareIssue).toHaveBeenCalledBefore(withAuthority);
    expect(issue).toHaveBeenCalledWith(expectedBindings());
  });

  it.each(["archived document", "cross-Workspace document id"])(
    "fails closed for an %s without signing",
    async () => {
      const issue = vi.fn(async () => "must-not-sign");
      const service = createCollaborationCapabilityService({
        generateSessionId: () => sessionA,
        prepareIssue: vi.fn(async () => issue),
        withAuthority: vi.fn(async () => null),
      });

      await expect(service.issue(context, { documentId: "document-a" }))
        .rejects.toMatchObject({ category: "not_found" });
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid server session identifier with a bounded parameter-free error", async () => {
    const sessionId = `secret-${"x".repeat(300)}`;
    const service = createCollaborationCapabilityService({
      generateSessionId: () => sessionId,
      prepareIssue: vi.fn(async () => vi.fn()),
      withAuthority: vi.fn(),
    });

    const failure = await captureFailure(() => service.issue(context, { documentId: "document-a" }));

    expect(failure).toBeInstanceOf(CollaborationCapabilityServiceError);
    expect(failure).toMatchObject({ category: "invalid_request" });
    expect(failure.message.length).toBeLessThanOrEqual(120);
    expect(failure.message).not.toContain(sessionId);
  });
});

async function signCustomToken(
  protectedHeader: { alg?: string; kid?: string } = {},
  overrides: Record<string, unknown> = {},
) {
  const claims: Record<string, unknown> = {
    aud: "coredot-collaboration",
    authorizationEpoch: 7,
    documentId: "document-a",
    exp: nowSeconds + 60,
    iat: nowSeconds,
    iss: "coredot-editor",
    jti: "11111111-1111-4111-8111-111111111111",
    nbf: nowSeconds - 1,
    permission: "write",
    principalId: context.principalId,
    room,
    sessionId: sessionA,
    workspaceId: context.workspaceId,
    ...overrides,
  };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[key];
  }
  const token = new SignJWT(claims)
    .setProtectedHeader({ alg: protectedHeader.alg ?? "ES256", kid: protectedHeader.kid ?? "2026-07-a", typ: "JWT" });
  return token.sign(activePrivateKey);
}

async function captureFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}

function tamperProtectedHeader(token: string, overrides: Record<string, unknown>) {
  const [header, payload, signature] = token.split(".");
  const parsed = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>;
  const encoded = Buffer.from(JSON.stringify({ ...parsed, ...overrides })).toString("base64url");
  return `${encoded}.${payload}.${signature}`;
}
