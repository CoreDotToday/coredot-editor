import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertExactJsonResponse,
  assertProtectedPageResponse,
  assertRedirectResponse,
  createProductionSmokeEnvironment,
  fetchSmokeResponse,
  runCleanupSteps,
  withPhaseTimeout,
} from "./run-production-smoke";

describe("production smoke helpers", () => {
  it("keeps the default local SQLite parent directory in clean checkouts", async () => {
    const root = resolve(import.meta.dirname, "../..");

    await expect(access(resolve(root, "data/.gitkeep"))).resolves.toBeUndefined();
  });

  it("keys the Docs workflow pip cache from the documentation requirements file", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const workflow = await readFile(resolve(root, ".github/workflows/docs.yml"), "utf8");

    expect(workflow).toContain("cache-dependency-path: requirements-docs.txt");
  });

  it("keeps the package and CI production gates wired without duplicating the release gate", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts["e2e:production"]).toBe(
      "tsx scripts/e2e/run-production-smoke.ts",
    );
    expect(packageJson.scripts["release:check"]).not.toMatch(/e2e:production|docs:build/);
    expect(workflow).toContain("uses: actions/setup-python@v5");
    expect(workflow).toContain("python -m pip install -r requirements-docs.txt");
    const nodeSqliteJob = workflow
      .split(/\n(?=  [\w-]+:\s*$)/m)
      .find((job) => job.startsWith("  node-sqlite-concurrency:"));

    expect(nodeSqliteJob).toBeDefined();
    expect(nodeSqliteJob).toContain("node-version: 24");
    expect(nodeSqliteJob).toContain(
      "node -e \"if (!require('node:module').isBuiltin('node:sqlite')) process.exit(1)\"",
    );
    expect(nodeSqliteJob).toContain(
      "pnpm exec vitest run src/features/proposals/proposal-concurrency.test.ts",
    );
    expect(workflow).toContain("run: pnpm e2e:production");
    expect(workflow).toContain("run: pnpm docs:build");
    expect(workflow.indexOf("run: pnpm build")).toBeLessThan(
      workflow.indexOf("run: pnpm e2e:production"),
    );
  });

  it("builds a production Clerk environment without inheriting real secrets", () => {
    const environment = createProductionSmokeEnvironment(
      {
        AI_PROVIDER: "openai",
        AWS_SECRET_ACCESS_KEY: "real-aws-secret",
        AUTH_MODE: "test",
        CLERK_SECRET_KEY: "real-clerk-secret",
        COREDOT_API_KEY: "real-coredot-secret",
        CI: "true",
        DATABASE_AUTH_TOKEN: "real-database-secret",
        DATABASE_URL: "libsql://private.example",
        HOME: "/tmp/smoke-home",
        HTTPS_PROXY: "https://proxy.example/secret-token",
        NEXT_PUBLIC_UNSAFE_CONFIG: "unsafe-next-config",
        NODE_ENV: "test",
        NODE_OPTIONS: "--require=/tmp/secret-hook.cjs",
        OPENAI_API_KEY: "real-openai-secret",
        PATH: "/usr/bin:/bin",
        TEST_PRINCIPAL_ID: "test-principal",
        TEST_WORKSPACE_ID: "test-workspace",
        TMPDIR: "/tmp/smoke-tmp",
        TURSO_AUTH_TOKEN: "real-turso-secret",
      },
      {
        databaseUrl: "file:/tmp/isolated-production-smoke.db",
        port: 43123,
      },
    );

    expect(environment).toMatchObject({
      AI_PROVIDER: "stub",
      AUTH_MODE: "clerk",
      CLERK_SIGN_IN_URL: "/sign-in",
      CLERK_SECRET_KEY: "sk_test_production_smoke",
      CI: "true",
      DATABASE_URL: "file:/tmp/isolated-production-smoke.db",
      HOME: "/tmp/smoke-home",
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      PORT: "43123",
      TMPDIR: "/tmp/smoke-tmp",
    });
    for (const name of [
      "DATABASE_AUTH_TOKEN",
      "TURSO_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "COREDOT_API_KEY",
      "TEST_PRINCIPAL_ID",
      "TEST_WORKSPACE_ID",
      "AWS_SECRET_ACCESS_KEY",
      "HTTPS_PROXY",
      "NEXT_PUBLIC_UNSAFE_CONFIG",
      "NODE_OPTIONS",
    ]) {
      expect(Object.hasOwn(environment, name), name).toBe(false);
    }
    expect(JSON.stringify(environment)).not.toMatch(/real-(?:clerk|database|turso|openai|coredot)-secret/);
  });

  it("checks exact generic JSON and cache headers without echoing a secret body", async () => {
    const response = Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" }, status: 200 },
    );

    await expect(
      assertExactJsonResponse(response, 200, { status: "ready" }),
    ).resolves.toBeUndefined();

    const unsafe = new Response("libsql://user:secret-token@private.example", { status: 503 });
    await expect(
      assertExactJsonResponse(unsafe, 200, { status: "ready" }),
    ).rejects.toThrow("Production smoke HTTP contract failed");
  });

  it("checks root redirect semantics without including the source URL in failures", () => {
    expect(() => assertRedirectResponse(new Response(null, {
      headers: { Location: "/documents" },
      status: 307,
    }), "/documents")).not.toThrow();

    expect(() => assertRedirectResponse(new Response("secret-body", {
      headers: { Location: "https://private.example/secret-token" },
      status: 200,
    }), "/documents")).toThrow("Production smoke redirect contract failed");
  });

  it("requires the actual protected page to redirect to the deterministic Clerk sign-in route", () => {
    expect(() => assertProtectedPageResponse(new Response(null, {
      headers: { Location: "/sign-in?redirect_url=%2Fdocuments" },
      status: 307,
    }))).not.toThrow();

    expect(() => assertProtectedPageResponse(new Response("private app shell", {
      headers: { Location: "https://private.example/secret-token" },
      status: 200,
    }))).toThrow("Production smoke protected page contract failed");

    for (const status of [401, 403]) {
      expect(() => assertProtectedPageResponse(new Response(null, {
        status,
      }))).toThrow("Production smoke protected page contract failed");
    }
  });

  it("keeps the fetch deadline active when cancelling a stalled body never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      cancel,
      pull: () => undefined,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    try {
      const pending = fetchSmokeResponse("http://127.0.0.1/api/ready", undefined, 25);
      let failure: unknown;
      void pending.catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(failure).toEqual(new Error("Production smoke HTTP request failed"));
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attempts every bounded cleanup step even when earlier steps fail", async () => {
    const calls: string[] = [];

    await expect(runCleanupSteps([
      async () => {
        calls.push("stop");
        throw new Error("secret process detail");
      },
      async () => {
        calls.push("port");
      },
      async () => {
        calls.push("files");
      },
    ])).rejects.toThrow("Production smoke cleanup failed");

    expect(calls).toEqual(["stop", "port", "files"]);
  });

  it("bounds phases with a generic error and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const pending = withPhaseTimeout(
        new Promise<never>(() => undefined),
        25,
      );
      const rejection = expect(pending).rejects.toThrow("Production smoke phase timed out");
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
