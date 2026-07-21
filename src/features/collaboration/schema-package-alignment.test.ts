import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { COLLABORATION_SCHEMA_PACKAGE_VERSIONS } from "./schema-package-versions";

describe("collaboration schema package alignment", () => {
  it("exact-pins every declared Tiptap package to the fingerprinted runtime version", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = manifest.dependencies ?? {};
    const tiptapPackages = Object.entries(dependencies)
      .filter(([name]) => name.startsWith("@tiptap/"));
    const expectedPackageNames = [
      "@tiptap/core",
      "@tiptap/extension-character-count",
      "@tiptap/extension-collaboration",
      "@tiptap/extension-collaboration-caret",
      "@tiptap/extension-link",
      "@tiptap/extension-placeholder",
      "@tiptap/extension-table",
      "@tiptap/extension-task-item",
      "@tiptap/extension-task-list",
      "@tiptap/extension-typography",
      "@tiptap/html",
      "@tiptap/pm",
      "@tiptap/react",
      "@tiptap/starter-kit",
    ];

    expect(tiptapPackages.map(([name]) => name)).toEqual(expectedPackageNames);
    expect(Object.isFrozen(COLLABORATION_SCHEMA_PACKAGE_VERSIONS)).toBe(true);
    expect(tiptapPackages).toEqual(
      expectedPackageNames.map((name) => [name, COLLABORATION_SCHEMA_PACKAGE_VERSIONS.tiptap]),
    );
    expect(dependencies["y-prosemirror"]).toBe(
      COLLABORATION_SCHEMA_PACKAGE_VERSIONS.yProsemirror,
    );
    expect(dependencies.yjs).toBe(COLLABORATION_SCHEMA_PACKAGE_VERSIONS.yjs);
  });
});
