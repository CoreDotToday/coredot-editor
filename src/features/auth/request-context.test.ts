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

  it("allows an injected Clerk reader without live Clerk credentials", async () => {
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

    await expect(resolve()).resolves.toMatchObject({
      principalId: "clerk:user_1",
    });
    expect(readClerkIdentity).toHaveBeenCalledOnce();
  });
});
