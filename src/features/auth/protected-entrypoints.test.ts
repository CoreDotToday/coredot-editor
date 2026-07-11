import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError } from "./request-context";
import { setProtectedRequestContextDependenciesForTests } from "./route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";

const appDirectory = join(process.cwd(), "src/app");
const publicPageRoutes = new Set([
  "/",
  "/sign-in/[[...sign-in]]",
  "/sign-up/[[...sign-up]]",
]);
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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

function getPageRoute(pageFile: string) {
  const relativeSegments = relative(appDirectory, pageFile).split(sep).slice(0, -1);
  const routeSegments = relativeSegments.filter(
    (segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"),
  );
  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
}

async function findServerActionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findServerActionFiles(path);
    if (!/\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      return [];
    }
    const source = await readFile(path, "utf8");
    return /["']use server["']\s*;?/.test(source) ? [path] : [];
  }));
  return nested.flat();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function analyzeRouteMethodExports(source: string, fileName = "route.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: string[] = [];
  const violations: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && httpMethods.has(statement.name.text)) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      methods.push(statement.name.text);
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        violations.push(`${statement.name.text} must be a named export`);
      } else if (!hasModifier(statement, ts.SyntaxKind.AsyncKeyword) || !statement.body) {
        violations.push(`${statement.name.text} must be an exported async function declaration with a body`);
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text)) {
          violations.push(`${declaration.name.text} must not be exported from a variable declaration`);
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.exportClause) {
      violations.push("route files must not use export-star declarations");
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        if (httpMethods.has(exportedName)) {
          violations.push(`${exportedName} must not be re-exported`);
        }
      }
    }
  }

  return { methods, violations };
}

describe("protected server entrypoints", () => {
  it("requires every API route to use the centralized protected route seam", async () => {
    const routeFiles = await findFiles(join(appDirectory, "api"), "route.ts");

    expect(routeFiles.length).toBeGreaterThan(0);
    for (const routeFile of routeFiles) {
      const source = await readFile(routeFile, "utf8");
      const analysis = analyzeRouteMethodExports(source, routeFile);
      expect(source, relative(process.cwd(), routeFile)).toContain("createProtectedRouteHandler");
      expect(source, relative(process.cwd(), routeFile)).not.toMatch(/workspaceId\s*:\s*["']local["']/);
      expect(analysis.methods.length, relative(process.cwd(), routeFile)).toBeGreaterThan(0);
      expect(analysis.violations, relative(process.cwd(), routeFile)).toEqual([]);
    }
  });

  it("rejects variable, typed const, non-async, and re-exported route methods", () => {
    const analysis = analyzeRouteMethodExports(`
      export const GET = handler;
      export const POST: RouteHandler = handler;
      export function PUT() {}
      export { patchHandler as PATCH };
      export async function DELETE() {}
      export default async function HEAD() {}
      export * from "./shared-methods";
    `);

    expect(analysis.methods).toEqual(["PUT", "DELETE", "HEAD"]);
    expect(analysis.violations).toEqual([
      "GET must not be exported from a variable declaration",
      "POST must not be exported from a variable declaration",
      "PUT must be an exported async function declaration with a body",
      "PATCH must not be re-exported",
      "HEAD must be a named export",
      "route files must not use export-star declarations",
    ]);
  });

  it("requires every non-public page and server action to use the page context seam", async () => {
    const pageFiles = await findFiles(appDirectory, "page.tsx");
    const protectedPageFiles = pageFiles.filter((pageFile) => !publicPageRoutes.has(getPageRoute(pageFile)));
    const serverActionFiles = await findServerActionFiles(appDirectory);

    const discoveredRoutes = new Set(pageFiles.map(getPageRoute));
    for (const publicRoute of publicPageRoutes) {
      expect(discoveredRoutes, `public route ${publicRoute}`).toContain(publicRoute);
    }
    expect(protectedPageFiles.length).toBeGreaterThan(0);
    for (const pageFile of [...protectedPageFiles, ...serverActionFiles]) {
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
