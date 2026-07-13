import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PUBLIC_API_ROUTES, isPublicApiPath } from "@/features/auth/public-api-routes";
import { shouldProtectWithClerk } from "./proxy";

function request(pathname: string) {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("Clerk proxy protection", () => {
  it("keeps the public operations inventory exact", () => {
    expect(PUBLIC_API_ROUTES).toEqual(["/api/health", "/api/ready"]);
    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/ready")).toBe(true);
    expect(isPublicApiPath("/api/health/details")).toBe(false);
    expect(isPublicApiPath("/api/ready/anything")).toBe(false);
    expect(isPublicApiPath("/api/documents")).toBe(false);
  });

  it("allows only the declared public operations endpoints as public APIs", () => {
    expect(shouldProtectWithClerk(request("/api/health"))).toBe(false);
    expect(shouldProtectWithClerk(request("/api/ready"))).toBe(false);
  });

  it("lets API requests reach the centralized JSON auth seam", () => {
    expect(shouldProtectWithClerk(request("/api/documents"))).toBe(false);
    expect(shouldProtectWithClerk(request("/api/documents/doc-1"))).toBe(false);
  });

  it("continues protecting private pages while allowing public pages", () => {
    expect(shouldProtectWithClerk(request("/documents"))).toBe(true);
    expect(shouldProtectWithClerk(request("/templates"))).toBe(true);
    expect(shouldProtectWithClerk(request("/"))).toBe(false);
    expect(shouldProtectWithClerk(request("/sign-in"))).toBe(false);
    expect(shouldProtectWithClerk(request("/sign-up/verify"))).toBe(false);
  });
});
