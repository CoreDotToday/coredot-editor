import { describe, expect, it } from "vitest";
import { assertProductionAuthConfigured } from "./production-auth-config.mjs";

function productionEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    AUTH_MODE: "clerk",
    CLERK_SECRET_KEY: "sk_test_unit",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
    NODE_ENV: "production",
    ...overrides,
  };
}

describe("production auth configuration", () => {
  it("rejects test authentication in production", () => {
    expect(() =>
      assertProductionAuthConfigured(
        productionEnv({ AUTH_MODE: "test" }),
      ),
    ).toThrow("Test authentication is disabled in production");
  });

  it.each([
    ["missing publishable key", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined }],
    ["blank publishable key", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "  " }],
    ["missing secret key", { CLERK_SECRET_KEY: undefined }],
    ["blank secret key", { CLERK_SECRET_KEY: "  " }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(() =>
      assertProductionAuthConfigured(productionEnv(overrides)),
    ).toThrow("Clerk authentication is not configured");
  });

  it("accepts trimmed Clerk credentials in production", () => {
    expect(() =>
      assertProductionAuthConfigured(
        productionEnv({
          CLERK_SECRET_KEY: "  sk_test_unit  ",
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
            "  pk_test_Y2xlcmsuZXhhbXBsZS5jb20k  ",
        }),
      ),
    ).not.toThrow();
  });

  it("does not require Clerk credentials outside production", () => {
    expect(() =>
      assertProductionAuthConfigured({
        AUTH_MODE: "test",
        CLERK_SECRET_KEY: "",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
        NODE_ENV: "development",
      }),
    ).not.toThrow();
  });
});
