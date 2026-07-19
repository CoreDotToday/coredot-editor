import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(tiptapPackages).toEqual(
      expectedPackageNames.map((name) => [name, "3.27.4"]),
    );
    expect(dependencies["y-prosemirror"]).toBe("1.3.7");
    expect(dependencies.yjs).toBe("13.6.31");
  });
});
