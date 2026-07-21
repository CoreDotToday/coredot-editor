import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSignedTestIdentityHeader,
  createTestRequestContext,
  TEST_IDENTITY_HEADER,
  TestIdentityOverrideError,
} from "./test-request-context";

const secret = "test-identity-secret-that-is-long-enough-123456";
const now = new Date("2026-07-19T09:00:00.000Z");

describe("test request identity override", () => {
  it("keeps the existing default test identity when no signed header is supplied", () => {
    expect(createTestRequestContext({
      AUTH_MODE: "test",
      NODE_ENV: "test",
      TEST_PRINCIPAL_ID: "test:principal:default",
      TEST_WORKSPACE_ID: "test:workspace:default",
    })).toMatchObject({
      principalId: "test:principal:default",
      workspaceId: "test:workspace:default",
    });
  });

  it("selects a bounded multi-user identity only with a valid unexpired HMAC header", () => {
    const value = createSignedTestIdentityHeader({
      expiresAt: new Date(now.getTime() + 30_000),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret);
    const headers = new Headers({ [TEST_IDENTITY_HEADER]: value });

    expect(createTestRequestContext({
      AUTH_MODE: "test",
      NODE_ENV: "test",
      TEST_IDENTITY_SIGNING_SECRET: secret,
    }, { headers, now })).toMatchObject({
      authMode: "test",
      principalId: "test:principal:alice",
      role: "owner",
      workspaceId: "test:workspace:shared",
    });
  });

  it.each([
    ["bad signature", (valid: string) => `${valid.slice(0, -1)}x`, "test"],
    ["expired", () => createSignedTestIdentityHeader({
      expiresAt: new Date(now.getTime() - 1),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret), "test"],
    ["production", (valid: string) => valid, "production"],
  ] as const)("fails closed for a %s identity override", (_label, mutate, nodeEnvironment) => {
    const valid = createSignedTestIdentityHeader({
      expiresAt: new Date(now.getTime() + 30_000),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret);

    expect(() => createTestRequestContext({
      AUTH_MODE: "test",
      NODE_ENV: nodeEnvironment,
      TEST_IDENTITY_SIGNING_SECRET: secret,
    }, {
      headers: new Headers({ [TEST_IDENTITY_HEADER]: mutate(valid) }),
      now,
    })).toThrow(TestIdentityOverrideError);
  });

  it("ignores an identity header when the test signing secret is not configured", () => {
    const value = createSignedTestIdentityHeader({
      expiresAt: new Date(now.getTime() + 30_000),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret);

    expect(createTestRequestContext({ AUTH_MODE: "test", NODE_ENV: "test" }, {
      headers: new Headers({ [TEST_IDENTITY_HEADER]: value }),
      now,
    })).toMatchObject({
      principalId: "test:principal:local",
      workspaceId: "test:workspace:local",
    });
  });

  it("rejects overlong headers and noncanonical identities without reflecting their contents", () => {
    const oversized = `secret-${"x".repeat(3_000)}`;

    expect(() => createTestRequestContext({
      AUTH_MODE: "test",
      NODE_ENV: "test",
      TEST_IDENTITY_SIGNING_SECRET: secret,
    }, {
      headers: new Headers({ [TEST_IDENTITY_HEADER]: oversized }),
      now,
    })).toThrow("Test identity override is invalid");
  });

  it.each([
    ["extra field", `{"exp":${Math.floor(now.getTime() / 1_000) + 30},"principalId":"test:principal:alice","workspaceId":"test:workspace:shared","role":"owner"}`],
    ["duplicate field", `{"exp":${Math.floor(now.getTime() / 1_000) + 30},"principalId":"test:principal:alice","principalId":"test:principal:bob","workspaceId":"test:workspace:shared"}`],
    ["noncanonical order", `{"principalId":"test:principal:alice","exp":${Math.floor(now.getTime() / 1_000) + 30},"workspaceId":"test:workspace:shared"}`],
  ])("rejects a correctly signed but strict-schema-invalid payload: %s", (_label, payload) => {
    const encoded = Buffer.from(payload).toString("base64url");
    const signature = createHmac("sha256", secret).update(encoded).digest("base64url");

    expect(() => createTestRequestContext({
      AUTH_MODE: "test",
      NODE_ENV: "test",
      TEST_IDENTITY_SIGNING_SECRET: secret,
    }, {
      headers: new Headers({ [TEST_IDENTITY_HEADER]: `${encoded}.${signature}` }),
      now,
    })).toThrow("Test identity override is invalid");
  });
});
