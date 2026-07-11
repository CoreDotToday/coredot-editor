export const CLERK_NOT_CONFIGURED_ERROR =
  "Clerk authentication is not configured";
export const TEST_AUTH_IN_PRODUCTION_ERROR =
  "Test authentication is disabled in production";

const hasValue = (value) => Boolean(value?.trim());

export function assertProductionAuthConfigured(env) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  if (env.AUTH_MODE?.trim() === "test") {
    throw new Error(TEST_AUTH_IN_PRODUCTION_ERROR);
  }

  if (
    !hasValue(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
    !hasValue(env.CLERK_SECRET_KEY)
  ) {
    throw new Error(CLERK_NOT_CONFIGURED_ERROR);
  }
}
