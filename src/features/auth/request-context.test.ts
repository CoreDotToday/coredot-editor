import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationRequiredError,
  createRequestContextResolver,
} from "./request-context";

describe("request context", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a Clerk organization to a shared Workspace", async () => {
    const resolve = createRequestContextResolver({
      environment: "development",
      readClerkIdentity: async () => ({
        orgId: "org_1",
        orgRole: "org:admin",
        userId: "user_1",
      }),
    });

    await expect(resolve()).resolves.toMatchObject({
      principalId: "clerk:user_1",
      role: "admin",
      workspaceId: "clerk:org:org_1",
    });
  });

  it("refuses test identity in production", async () => {
    const resolve = createRequestContextResolver({
      environment: "production",
      mode: "test",
    });

    await expect(resolve()).rejects.toThrow(
      "Test authentication is disabled in production",
    );
  });

  it("maps a Clerk user without an organization to a personal Workspace", async () => {
    const resolve = createRequestContextResolver({
      environment: "development",
      readClerkIdentity: async () => ({
        orgId: null,
        orgRole: null,
        userId: "user_1",
      }),
    });

    await expect(resolve()).resolves.toMatchObject({
      authMode: "clerk",
      principalId: "clerk:user_1",
      role: "owner",
      workspaceId: "clerk:user:user_1",
    });
  });

  it.each([
    ["org:owner", "owner"],
    ["org:admin", "admin"],
    ["org:member", "member"],
    ["org:custom", "member"],
    [null, "member"],
  ] as const)("normalizes Clerk role %s to %s", async (orgRole, role) => {
    const resolve = createRequestContextResolver({
      environment: "development",
      readClerkIdentity: async () => ({
        orgId: "org_1",
        orgRole,
        userId: "user_1",
      }),
    });

    await expect(resolve()).resolves.toMatchObject({ role });
  });

  it("requires an authenticated Clerk user", async () => {
    const resolve = createRequestContextResolver({
      environment: "development",
      readClerkIdentity: async () => ({
        orgId: null,
        orgRole: null,
        userId: null,
      }),
    });

    await expect(resolve()).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
  });

  it("reads deterministic test identity IDs from the environment", async () => {
    vi.stubEnv("AUTH_MODE", "test");
    vi.stubEnv("TEST_PRINCIPAL_ID", "test:principal:7");
    vi.stubEnv("TEST_WORKSPACE_ID", "test:workspace:8");
    const resolve = createRequestContextResolver({
      environment: "test",
    });

    await expect(resolve()).resolves.toMatchObject({
      authMode: "test",
      principalId: "test:principal:7",
      role: "owner",
      workspaceId: "test:workspace:8",
    });
  });

  it("reads a valid signed test identity header through the injected request-header seam", async () => {
    const { createSignedTestIdentityHeader, TEST_IDENTITY_HEADER } = await import("./test-request-context");
    const secret = "test-identity-secret-that-is-long-enough-123456";
    const now = new Date();
    const header = createSignedTestIdentityHeader({
      expiresAt: new Date(now.getTime() + 30_000),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret);
    const resolve = createRequestContextResolver({
      env: {
        AUTH_MODE: "test",
        NODE_ENV: "test",
        TEST_IDENTITY_SIGNING_SECRET: secret,
      },
      environment: "test",
      readTestRequestHeaders: async () => new Headers({ [TEST_IDENTITY_HEADER]: header }),
    });

    await expect(resolve()).resolves.toMatchObject({
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    });
  });

  it("cannot bypass the effective production environment with a signed test header", async () => {
    const { createSignedTestIdentityHeader, TEST_IDENTITY_HEADER } = await import("./test-request-context");
    const secret = "test-identity-secret-that-is-long-enough-123456";
    const header = createSignedTestIdentityHeader({
      expiresAt: new Date(Date.now() + 30_000),
      principalId: "test:principal:alice",
      workspaceId: "test:workspace:shared",
    }, secret);
    const resolve = createRequestContextResolver({
      env: {
        AUTH_MODE: "test",
        NODE_ENV: "development",
        TEST_IDENTITY_SIGNING_SECRET: secret,
      },
      environment: "production",
      mode: "test",
      readTestRequestHeaders: async () => new Headers({ [TEST_IDENTITY_HEADER]: header }),
    });

    await expect(resolve()).rejects.toThrow("Test authentication is disabled in production");
  });

  it("fails closed in production when Clerk credentials are absent", async () => {
    const resolve = createRequestContextResolver({
      env: { NODE_ENV: "production" },
      environment: "production",
      mode: "clerk",
    });

    await expect(resolve()).rejects.toThrow(
      "Clerk authentication is not configured",
    );
  });

  it("rejects an injected Clerk reader without production credentials", async () => {
    const readClerkIdentity = vi.fn(async () => ({
      orgId: null,
      orgRole: null,
      userId: "user_1",
    }));
    const resolve = createRequestContextResolver({
      env: { NODE_ENV: "production" },
      environment: "production",
      readClerkIdentity,
    });

    await expect(resolve()).rejects.toThrow(
      "Clerk authentication is not configured",
    );
    expect(readClerkIdentity).not.toHaveBeenCalled();
  });

  it("allows production injection only with explicit Clerk credentials", async () => {
    const readClerkIdentity = vi.fn(async () => ({
      orgId: null,
      orgRole: null,
      userId: "user_1",
    }));
    const resolve = createRequestContextResolver({
      clerkPublishableKey: "pk_test_unit",
      clerkSecretKey: "sk_test_unit",
      env: { NODE_ENV: "production" },
      environment: "production",
      readClerkIdentity,
    });

    await expect(resolve()).resolves.toMatchObject({
      principalId: "clerk:user_1",
    });
    expect(readClerkIdentity).toHaveBeenCalledOnce();
  });

  it("does not authorize production injection from ambient Clerk credentials", async () => {
    const readClerkIdentity = vi.fn(async () => ({
      orgId: null,
      orgRole: null,
      userId: "user_1",
    }));
    const resolve = createRequestContextResolver({
      env: {
        CLERK_SECRET_KEY: "sk_test_ambient",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ambient",
        NODE_ENV: "production",
      },
      environment: "production",
      readClerkIdentity,
    });

    await expect(resolve()).rejects.toThrow(
      "Clerk authentication is not configured",
    );
    expect(readClerkIdentity).not.toHaveBeenCalled();
  });
});
