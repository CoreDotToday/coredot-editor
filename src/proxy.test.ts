import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_API_ROUTES, isPublicApiPath } from "@/features/auth/public-api-routes";

const clerkServerMocks = vi.hoisted(() => {
  const clerkProxy = vi.fn();

  return {
    clerkMiddleware: vi.fn(() => clerkProxy),
    clerkProxy,
    createRouteMatcher: vi.fn(() => vi.fn()),
  };
});

vi.mock("@clerk/nextjs/server", () => clerkServerMocks);

describe("Clerk proxy protection", () => {
  beforeEach(() => {
    clerkServerMocks.clerkMiddleware.mockClear();
    clerkServerMocks.createRouteMatcher.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the public operations inventory exact", () => {
    expect(PUBLIC_API_ROUTES).toEqual(["/api/health", "/api/ready"]);
    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/ready")).toBe(true);
    expect(isPublicApiPath("/api/health/details")).toBe(false);
    expect(isPublicApiPath("/api/ready/anything")).toBe(false);
    expect(isPublicApiPath("/api/documents")).toBe(false);
  });

  it("uses Clerk only to provide auth context to protected resources", async () => {
    vi.stubEnv("AUTH_MODE", "clerk");
    vi.resetModules();

    const proxyModule = await import("./proxy");

    expect(clerkServerMocks.createRouteMatcher).not.toHaveBeenCalled();
    expect(clerkServerMocks.clerkMiddleware).toHaveBeenCalledOnce();
    expect(clerkServerMocks.clerkMiddleware).toHaveBeenCalledWith();
    expect(proxyModule.default).toBe(clerkServerMocks.clerkProxy);
  });
});
