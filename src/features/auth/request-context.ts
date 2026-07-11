import { createTestRequestContext } from "./test-request-context";

export type WorkspaceRole = "admin" | "member" | "owner";

export type RequestContext = {
  authMode: "clerk" | "test";
  principalId: string;
  requestId: string;
  role: WorkspaceRole;
  workspaceId: string;
};

export type ClerkIdentity = {
  orgId: string | null | undefined;
  orgRole: string | null | undefined;
  userId: string | null | undefined;
};

export class AuthenticationRequiredError extends Error {
  constructor(message = "Authentication is required") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

type AuthMode = RequestContext["authMode"];
type RuntimeEnvironment = "development" | "production" | "test";
type ReadClerkIdentity = () => Promise<ClerkIdentity>;

type RequestContextResolverOptions = {
  clerkPublishableKey?: string;
  clerkSecretKey?: string;
  env?: NodeJS.ProcessEnv;
  environment?: RuntimeEnvironment;
  mode?: AuthMode;
  readClerkIdentity?: ReadClerkIdentity;
};

function normalizeWorkspaceRole(orgRole: string | null | undefined): WorkspaceRole {
  if (orgRole === "org:owner") {
    return "owner";
  }

  if (orgRole === "org:admin") {
    return "admin";
  }

  return "member";
}

function mapClerkIdentity(identity: ClerkIdentity): RequestContext {
  if (!identity.userId) {
    throw new AuthenticationRequiredError();
  }

  const hasOrganization = Boolean(identity.orgId);

  return {
    authMode: "clerk",
    principalId: `clerk:${identity.userId}`,
    requestId: crypto.randomUUID(),
    role: hasOrganization ? normalizeWorkspaceRole(identity.orgRole) : "owner",
    workspaceId: hasOrganization
      ? `clerk:org:${identity.orgId}`
      : `clerk:user:${identity.userId}`,
  };
}

function hasClerkCredentials(
  publishableKey: string | undefined,
  secretKey: string | undefined,
): boolean {
  return Boolean(publishableKey?.trim() && secretKey?.trim());
}

export function createRequestContextResolver(
  options: RequestContextResolverOptions = {},
): () => Promise<RequestContext> {
  const env = options.env ?? process.env;
  const environment = options.environment ?? env.NODE_ENV ?? "development";
  const mode = options.mode ?? (env.AUTH_MODE === "test" ? "test" : "clerk");

  return async () => {
    if (mode === "test") {
      if (environment === "production") {
        throw new Error("Test authentication is disabled in production");
      }

      return createTestRequestContext(env);
    }

    if (environment === "production") {
      const credentialsAreConfigured = options.readClerkIdentity
        ? hasClerkCredentials(
            options.clerkPublishableKey,
            options.clerkSecretKey,
          )
        : hasClerkCredentials(
            env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
            env.CLERK_SECRET_KEY,
          );

      if (!credentialsAreConfigured) {
        throw new Error("Clerk authentication is not configured");
      }
    }

    const readIdentity =
      options.readClerkIdentity ??
      (await import("./clerk-request-context")).readClerkIdentity;

    return mapClerkIdentity(await readIdentity());
  };
}

export const resolveRequestContext = createRequestContextResolver();
