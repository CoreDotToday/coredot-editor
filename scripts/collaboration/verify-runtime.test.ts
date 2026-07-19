import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type RuntimeVerification,
  verifyRuntimeConfiguration,
} from "./verify-runtime";

const root = process.cwd();

describe("collaboration runtime configuration", () => {
  it("keeps the repository on the minimum supported Node runtime", async () => {
    await expect(verifyRuntimeConfiguration(root)).resolves.toEqual({
      minimumMajor: 22,
      ok: true,
    });
  });

  it("pins local Node selection to Node 22", async () => {
    const nvmrc = await readFile(resolve(root, ".nvmrc"), "utf8");

    expect(nvmrc.trim()).toMatch(/^22(?:\.|$)/);
  });

  it("returns bounded path-only errors without echoing file contents", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "coredot-collaboration-runtime-"));
    const secret = "do-not-echo-runtime-file-content";

    try {
      await mkdir(resolve(temporaryRoot, ".github/workflows"), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(temporaryRoot, "package.json"),
          JSON.stringify({
            engines: { node: ">=20" },
            privateMetadata: secret,
            scripts: { "build:docx-worker": "esbuild --target=node20" },
          }),
        ),
        writeFile(
          resolve(temporaryRoot, ".github/workflows/ci.yml"),
          `uses: actions/setup-node@v7\nnode-version: 20\n# ${secret}\n`,
        ),
        writeFile(
          resolve(temporaryRoot, ".github/workflows/docs.yml"),
          `uses: actions/setup-node@v7\nnode-version: 20\n# ${secret}\n`,
        ),
      ]);

      const result: RuntimeVerification = await verifyRuntimeConfiguration(temporaryRoot);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected invalid runtime configuration");
      expect(result).toEqual({ errors: expect.any(Array), ok: false });
      expect(result.errors).not.toHaveLength(0);
      expect(result.errors.length).toBeLessThanOrEqual(8);
      expect(result.errors.every((error) => /^(package\.json|\.github\/workflows\/(?:ci|docs)\.yml):/.test(error))).toBe(true);
      expect(result.errors.join("\n")).not.toContain(secret);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("rejects setup-node steps whose own Node version is missing", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "coredot-collaboration-runtime-"));

    try {
      await mkdir(resolve(temporaryRoot, ".github/workflows"), { recursive: true });
      const validWorkflow = `jobs:\n  verify:\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n`;
      await Promise.all([
        writeFile(
          resolve(temporaryRoot, "package.json"),
          JSON.stringify({
            engines: { node: ">=22.13.0" },
            scripts: { "build:docx-worker": "esbuild --target=node22" },
          }),
        ),
        writeFile(
          resolve(temporaryRoot, ".github/workflows/ci.yml"),
          `jobs:\n  verify:\n    metadata:\n      node-version: 22\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          cache: pnpm\n`,
        ),
        writeFile(
          resolve(temporaryRoot, ".github/workflows/docs.yml"),
          validWorkflow,
        ),
      ]);

      const result = await verifyRuntimeConfiguration(temporaryRoot);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected invalid runtime configuration");
      expect(result.errors).toContain(
        ".github/workflows/ci.yml: every setup-node job must use Node 22",
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("rejects collaboration scripts outside the approved server contract", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "coredot-collaboration-runtime-"));

    try {
      await mkdir(resolve(temporaryRoot, ".github/workflows"), { recursive: true });
      const validWorkflow = `jobs:\n  verify:\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n`;
      await Promise.all([
        writeFile(
          resolve(temporaryRoot, "package.json"),
          JSON.stringify({
            engines: { node: ">=22.13.0" },
            scripts: {
              "build:docx-worker": "esbuild --target=node22",
              "collaboration:build": "esbuild src/features/collaboration/server/index.ts",
              "collaboration:dev": "tsx watch src/features/collaboration/server/index.ts",
            },
          }),
        ),
        writeFile(resolve(temporaryRoot, ".github/workflows/ci.yml"), validWorkflow),
        writeFile(resolve(temporaryRoot, ".github/workflows/docs.yml"), validWorkflow),
      ]);

      const result = await verifyRuntimeConfiguration(temporaryRoot);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected invalid runtime configuration");
      expect(result.errors).toContain(
        "package.json: collaboration scripts must match the approved server contract",
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("targets Node 22 in the schema profile worker bundle test", async () => {
    const source = await readFile(
      resolve(root, "src/plugins/document-schema-profile.test.ts"),
      "utf8",
    );

    expect(source).toContain('target: "node22"');
  });
});
