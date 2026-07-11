const hasValue = (value) => Boolean(value?.trim());
const env = process.argv.includes("--production")
  ? { ...process.env, NODE_ENV: "production" }
  : process.env;

if (env.NODE_ENV === "production") {
  if (env.AUTH_MODE?.trim() === "test") {
    throw new Error("Test authentication is disabled in production");
  }

  if (
    !hasValue(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
    !hasValue(env.CLERK_SECRET_KEY)
  ) {
    throw new Error("Clerk authentication is not configured");
  }
}
