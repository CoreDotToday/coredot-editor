import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { shouldProtectWithClerk } from "./proxy";

function request(pathname: string) {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("Clerk proxy protection", () => {
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
