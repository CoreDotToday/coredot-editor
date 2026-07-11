import { describe, expect, it, vi } from "vitest";
import {
  createProtectedOptionsHandler,
  createProtectedRouteHandler,
  getProtectedPageContext,
  requireWorkspaceAdministrator,
} from "./route-context";
import {
  AuthenticationRequiredError,
  type RequestContext,
} from "./request-context";

const ownerContext: RequestContext = {
  authMode: "test",
  principalId: "principal-a",
  requestId: "request-a",
  role: "owner",
  workspaceId: "workspace-a",
};

function createDependencies(
  overrides: Partial<{
    ensureWorkspaceBootstrap: (context: RequestContext) => Promise<void>;
    getRequestContext: () => Promise<RequestContext>;
  }> = {},
) {
  return {
    ensureWorkspaceBootstrap: vi.fn(async () => undefined),
    getRequestContext: vi.fn(async () => ownerContext),
    ...overrides,
  };
}

describe("protected route context", () => {
  it("returns an authenticated 204 OPTIONS response with normalized allowed methods", async () => {
    const dependencies = createDependencies();
    const handler = createProtectedOptionsHandler(["POST", "GET"], dependencies);

    const response = await handler();

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, POST, OPTIONS");
    expect(await response.text()).toBe("");
    expect(dependencies.ensureWorkspaceBootstrap).toHaveBeenCalledWith(ownerContext);
  });

  it("resolves and bootstraps the workspace before invoking a route", async () => {
    const callOrder: string[] = [];
    const dependencies = createDependencies({
      ensureWorkspaceBootstrap: vi.fn(async () => {
        callOrder.push("bootstrap");
      }),
      getRequestContext: vi.fn(async () => {
        callOrder.push("authenticate");
        return ownerContext;
      }),
    });
    const handler = createProtectedRouteHandler(async (context, request: Request) => {
      callOrder.push("handler");
      expect(context).toBe(ownerContext);
      expect(await request.json()).toEqual({ title: "Private" });
      return Response.json({ workspaceId: context.workspaceId });
    }, dependencies);

    const response = await handler(new Request("http://localhost/api/documents", {
      body: JSON.stringify({ title: "Private" }),
      method: "POST",
    }));

    expect(callOrder).toEqual(["authenticate", "bootstrap", "handler"]);
    expect(dependencies.ensureWorkspaceBootstrap).toHaveBeenCalledWith(ownerContext);
    await expect(response.json()).resolves.toEqual({ workspaceId: "workspace-a" });
  });

  it("returns a consistent 401 without bootstrapping or parsing the body when authentication is missing", async () => {
    const dependencies = createDependencies({
      getRequestContext: vi.fn(async () => {
        throw new AuthenticationRequiredError();
      }),
    });
    const handler = createProtectedRouteHandler(async (context, request: Request) => {
      void context;
      void request;
      throw new Error("the protected handler must not run");
    }, dependencies);

    const response = await handler(new Request("http://localhost/api/documents", {
      body: "{",
      method: "POST",
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    expect(dependencies.ensureWorkspaceBootstrap).not.toHaveBeenCalled();
  });

  it("does not translate unrelated resolver failures into authentication failures", async () => {
    const failure = new Error("database unavailable");
    const dependencies = createDependencies({
      getRequestContext: vi.fn(async () => {
        throw failure;
      }),
    });
    const handler = createProtectedRouteHandler(
      async (context, request: Request) => {
        void context;
        void request;
        return Response.json({ ok: true });
      },
      dependencies,
    );

    await expect(handler(new Request("http://localhost/api/documents"))).rejects.toBe(failure);
  });

  it("returns 403 for an authenticated member denied by a route authorization check", async () => {
    const memberContext = { ...ownerContext, role: "member" as const };
    const dependencies = createDependencies({
      getRequestContext: vi.fn(async () => memberContext),
    });
    const handler = createProtectedRouteHandler(async (context, request: Request) => {
      void request;
      requireWorkspaceAdministrator(context);
      return Response.json({ ok: true });
    }, dependencies);

    const response = await handler(new Request("http://localhost/api/templates", { method: "POST" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});

describe("protected page context", () => {
  it("bootstraps and returns an authenticated page context", async () => {
    const dependencies = createDependencies();

    await expect(getProtectedPageContext("/documents", dependencies)).resolves.toBe(ownerContext);
    expect(dependencies.ensureWorkspaceBootstrap).toHaveBeenCalledWith(ownerContext);
  });

  it("redirects an unauthenticated page to sign-in with a return URL", async () => {
    const redirectTo = vi.fn((location: string): never => {
      throw new Error(`redirect:${location}`);
    });
    const dependencies = {
      ...createDependencies({
        getRequestContext: vi.fn(async () => {
          throw new AuthenticationRequiredError();
        }),
      }),
      redirectTo,
    };

    await expect(getProtectedPageContext("/documents/doc-1", dependencies)).rejects.toThrow(
      "redirect:/sign-in?redirect_url=%2Fdocuments%2Fdoc-1",
    );
    expect(dependencies.ensureWorkspaceBootstrap).not.toHaveBeenCalled();
  });
});
