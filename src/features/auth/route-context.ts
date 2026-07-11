import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  resolveRequestContext,
  type RequestContext,
} from "./request-context";

export class WorkspaceAuthorizationError extends Error {
  constructor(message = "Workspace administrator access is required") {
    super(message);
    this.name = "WorkspaceAuthorizationError";
  }
}

export type ProtectedRequestContextDependencies = {
  ensureWorkspaceBootstrap: (context: RequestContext) => Promise<void>;
  getRequestContext: () => Promise<RequestContext>;
};

export type ProtectedRouteHandlerOptions<TArguments extends unknown[]> = {
  beforeWorkspaceBootstrap?: (
    context: RequestContext,
    ...args: TArguments
  ) => Promise<Response | null>;
};

type ProtectedPageContextDependencies = ProtectedRequestContextDependencies & {
  redirectTo?: (location: string) => never;
};
type ProtectedHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

const httpMethodOrder: readonly ProtectedHttpMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const defaultDependencies: ProtectedRequestContextDependencies = {
  ensureWorkspaceBootstrap: async (context) => {
    const workspaceBootstrap = await import("@/features/workspaces/workspace-bootstrap");
    await workspaceBootstrap.ensureWorkspaceBootstrap(context);
  },
  getRequestContext: resolveRequestContext,
};

export function setProtectedRequestContextDependenciesForTests(
  dependencies: ProtectedRequestContextDependencies,
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Protected request context overrides are test-only");
  }

  Object.assign(defaultDependencies, dependencies);
}

export function createProtectedRouteHandler<TArguments extends unknown[]>(
  handler: (context: RequestContext, ...args: TArguments) => Promise<Response>,
  optionsOrDependencies:
    | ProtectedRouteHandlerOptions<TArguments>
    | ProtectedRequestContextDependencies = defaultDependencies,
  explicitDependencies: ProtectedRequestContextDependencies = defaultDependencies,
) {
  const isDependencies = "ensureWorkspaceBootstrap" in optionsOrDependencies;
  const options = isDependencies ? {} : optionsOrDependencies;
  const dependencies = isDependencies ? optionsOrDependencies : explicitDependencies;

  return async (...args: TArguments): Promise<Response> => {
    try {
      const context = await dependencies.getRequestContext();
      const guardResponse = await options.beforeWorkspaceBootstrap?.(context, ...args);
      if (guardResponse) return guardResponse;
      await dependencies.ensureWorkspaceBootstrap(context);
      return await handler(context, ...args);
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }

      if (error instanceof WorkspaceAuthorizationError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      throw error;
    }
  };
}

export function createProtectedOptionsHandler(
  methods: readonly Exclude<ProtectedHttpMethod, "HEAD" | "OPTIONS">[],
  dependencies: ProtectedRequestContextDependencies = defaultDependencies,
) {
  const allowedMethods = new Set<ProtectedHttpMethod>(methods);
  if (allowedMethods.has("GET")) {
    allowedMethods.add("HEAD");
  }
  allowedMethods.add("OPTIONS");
  const allow = httpMethodOrder.filter((method) => allowedMethods.has(method)).join(", ");

  return createProtectedRouteHandler(
    async () => new Response(null, { headers: { Allow: allow }, status: 204 }),
    dependencies,
  );
}

export async function getProtectedPageContext(
  returnTo: string,
  dependencies: ProtectedPageContextDependencies = defaultDependencies,
): Promise<RequestContext> {
  try {
    return await getAuthenticatedWorkspaceContext(dependencies);
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) {
      throw error;
    }

    const redirectTo = dependencies.redirectTo ?? redirect;
    return redirectTo(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
  }
}

export function requireWorkspaceAdministrator(context: RequestContext) {
  if (context.role !== "owner" && context.role !== "admin") {
    throw new WorkspaceAuthorizationError();
  }
}

async function getAuthenticatedWorkspaceContext(
  dependencies: ProtectedRequestContextDependencies,
): Promise<RequestContext> {
  const context = await dependencies.getRequestContext();
  await dependencies.ensureWorkspaceBootstrap(context);
  return context;
}
