import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError } from "./request-context";
import { setProtectedRequestContextDependenciesForTests } from "./route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";

const appDirectory = join(process.cwd(), "src/app");

afterEach(() => {
  setProtectedRequestContextDependenciesForTests({
    ensureWorkspaceBootstrap: async () => undefined,
    getRequestContext: async () => TEST_REQUEST_CONTEXT,
  });
});

async function findFiles(directory: string, fileName: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(path, fileName);
    return entry.name === fileName ? [path] : [];
  }));
  return nested.flat();
}

describe("protected server entrypoints", () => {
  it("requires every API route to use the centralized protected route seam", async () => {
    const routeFiles = await findFiles(join(appDirectory, "api"), "route.ts");

    expect(routeFiles.length).toBeGreaterThan(0);
    for (const routeFile of routeFiles) {
      const source = await readFile(routeFile, "utf8");
      expect(source, relative(process.cwd(), routeFile)).toContain("createProtectedRouteHandler");
      expect(source, relative(process.cwd(), routeFile)).not.toMatch(/workspaceId\s*:\s*["']local["']/);
      expect(source, relative(process.cwd(), routeFile)).toMatch(/export async function (?:GET|POST|PUT|PATCH|DELETE)\(/);
      expect(source, relative(process.cwd(), routeFile)).not.toMatch(/export const (?:GET|POST|PUT|PATCH|DELETE)\s*=/);
    }
  });

  it("requires protected pages and their server actions to use the page context seam", async () => {
    const pageFiles = [
      join(appDirectory, "documents/page.tsx"),
      join(appDirectory, "documents/[id]/page.tsx"),
      join(appDirectory, "templates/page.tsx"),
    ];

    for (const pageFile of pageFiles) {
      const source = await readFile(pageFile, "utf8");
      expect(source, relative(process.cwd(), pageFile)).toContain("getProtectedPageContext");
      expect(source, relative(process.cwd(), pageFile)).not.toMatch(/workspaceId\s*:\s*["']local["']/);
    }
  });

  it("returns 401 from every API handler before entering route-specific code", async () => {
    const ensureWorkspaceBootstrap = vi.fn(async () => undefined);
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap,
      getRequestContext: async () => {
        throw new AuthenticationRequiredError();
      },
    });
    const routeModules = await Promise.all([
      import("@/app/api/ai/review/route"),
      import("@/app/api/ai/rewrite/route"),
      import("@/app/api/documents/route"),
      import("@/app/api/documents/[id]/route"),
      import("@/app/api/documents/[id]/export/route"),
      import("@/app/api/documents/import/route"),
      import("@/app/api/proposals/[id]/route"),
      import("@/app/api/proposals/[id]/apply/route"),
      import("@/app/api/settings/ai/route"),
      import("@/app/api/settings/ai/test/route"),
      import("@/app/api/templates/route"),
      import("@/app/api/templates/[id]/route"),
    ]);
    const handlers = routeModules.flatMap((routeModule) =>
      Object.entries(routeModule)
        .filter(([name, value]) => /^[A-Z]+$/.test(name) && typeof value === "function")
        .map(([, value]) => value as () => Promise<Response>),
    );

    expect(handlers).toHaveLength(18);
    for (const handler of handlers) {
      const response = await handler();
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    }
    expect(ensureWorkspaceBootstrap).not.toHaveBeenCalled();
  });
});
