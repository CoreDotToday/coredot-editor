import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

describe("server instrumentation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects invalid authentication before production readiness", () => {
    vi.stubEnv("AUTH_MODE", "test");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("NODE_ENV", "production");

    expect(() => register()).toThrow(
      "Test authentication is disabled in production",
    );
  });

  it("accepts a configured production Clerk server", () => {
    vi.stubEnv("AUTH_MODE", "clerk");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_unit");
    vi.stubEnv(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
    );
    vi.stubEnv("NODE_ENV", "production");

    expect(() => register()).not.toThrow();
  });
});
