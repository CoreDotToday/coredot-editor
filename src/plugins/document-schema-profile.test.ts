// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Extension } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { editorMessages } from "@/features/i18n/editor-language";
import { appDocumentSchemaProfile, createAppEditorPlugins } from "./app-plugins";
import { createEditorPluginRegistry } from "./registry";
import {
  createEditorSchemaExtensions,
  createServerSchemaExtensions,
} from "./document-schema-profile";

describe("document schema profile", () => {
  it("creates the same server-safe schema in the browser and conversion worker", () => {
    expect(createEditorSchemaExtensions(appDocumentSchemaProfile).map((extension) => extension.name)).toEqual(
      createServerSchemaExtensions(appDocumentSchemaProfile).map((extension) => extension.name),
    );
  });

  it("wires the app-selected profile into the browser plugin registry", () => {
    const selectedExtension = Extension.create({ name: "selectedServerSafeExtension" });
    const plugins = createAppEditorPlugins({
      appPlugins: [],
      schemaProfile: { id: "test.selected", extensions: () => [selectedExtension] },
    });
    const contributions = createEditorPluginRegistry(plugins).resolve({ language: "ko", messages: editorMessages.ko });

    expect(contributions.tiptapExtensions.map((extension) => extension.name)).toContain(
      "selectedServerSafeExtension",
    );
  });

  it("is the schema source imported by DOCX conversion", async () => {
    const conversionCore = await readFile(
      resolve(process.cwd(), "src/features/documents/docx-conversion-core.mjs"),
      "utf8",
    );

    expect(conversionCore).toContain("app-document-schema-profile-runtime.mjs");
    expect(conversionCore).not.toMatch(/@tiptap\/(?:extension-link|starter-kit)/);
  });

  it("keeps React and browser-only editor modules out of the actual worker CJS bundle graph", async () => {
    const bundle = await build({
      absWorkingDir: process.cwd(),
      bundle: true,
      entryPoints: ["src/features/documents/docx-conversion-worker.mjs"],
      format: "cjs",
      metafile: true,
      platform: "node",
      target: "node20",
      write: false,
    });
    const inputs = Object.keys(bundle.metafile.inputs);

    expect(inputs).toContain("src/plugins/document-schema-profile-runtime.mjs");
    expect(inputs).toContain("src/plugins/app-document-schema-profile-runtime.mjs");
    expect(inputs.some((input) => /(?:^|\/)react(?:-dom)?\//.test(input))).toBe(false);
    expect(inputs.some((input) => input.includes("@tiptap/react"))).toBe(false);
    expect(inputs.some((input) => input.includes("markdown-paste"))).toBe(false);
  });
});
