import { Extension } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { editorMessages } from "@/features/i18n/editor-language";
import { coreDocumentPlugin } from "./builtin/core-document-plugin";
import { createEditorPluginRegistry } from "./registry";
import type { EditorPlugin } from "./types";

function plugin(id: string, overrides: Partial<EditorPlugin> = {}): EditorPlugin {
  return {
    id,
    name: id,
    version: "0.0.0-test",
    ...overrides,
  };
}

const resolveInput = {
  language: "ko" as const,
  messages: editorMessages.ko,
};

describe("createEditorPluginRegistry", () => {
  it("keeps enabled plugins in dependency order", () => {
    const registry = createEditorPluginRegistry([
      plugin("feature", { dependencies: ["core"] }),
      plugin("core"),
    ]);

    expect(registry.plugins.map((item) => item.id)).toEqual(["core", "feature"]);
  });

  it("omits disabled plugins and their contributions", () => {
    const registry = createEditorPluginRegistry(
      [
        plugin("enabled", {
          selectionCommands: () => [
            {
              ariaLabel: "Enabled",
              command: "Enabled command",
              icon: "sparkles",
              id: "enabled.command",
              label: "Enabled",
            },
          ],
        }),
        plugin("disabled", {
          selectionCommands: () => [
            {
              ariaLabel: "Disabled",
              command: "Disabled command",
              icon: "sparkles",
              id: "disabled.command",
              label: "Disabled",
            },
          ],
        }),
      ],
      { disabledPluginIds: ["disabled"] },
    );

    expect(registry.plugins.map((item) => item.id)).toEqual(["enabled"]);
    expect(registry.resolve(resolveInput).selectionCommands.map((item) => item.id)).toEqual(["enabled.command"]);
  });

  it("throws on duplicate plugin ids", () => {
    expect(() => createEditorPluginRegistry([plugin("core"), plugin("core")])).toThrow(
      /Duplicate editor plugin id: core/,
    );
  });

  it("throws on missing dependencies", () => {
    expect(() => createEditorPluginRegistry([plugin("feature", { dependencies: ["missing"] })])).toThrow(
      /depends on missing plugin: missing/,
    );
  });

  it("throws on cyclic dependencies", () => {
    expect(() =>
      createEditorPluginRegistry([
        plugin("a", { dependencies: ["b"] }),
        plugin("b", { dependencies: ["a"] }),
      ]),
    ).toThrow(/Cyclic editor plugin dependency/);
  });

  it("flattens contributions deterministically with localized context", () => {
    const tiptapExtension = Extension.create({ name: "testPluginExtension" });
    const registry = createEditorPluginRegistry([
      plugin("core", {
        tiptapExtensions: () => [tiptapExtension],
        slashCommands: ({ messages }) => [
          {
            aliases: ["a"],
            command: () => {},
            group: "blocks",
            icon: "type",
            id: "core.a",
            label: messages.slashMenu.items.text.label,
            searchText: "a",
            subtext: "A command",
          },
        ],
      }),
      plugin("feature", {
        dependencies: ["core"],
        selectionCommands: ({ language, messages }) => [
          {
            ariaLabel: `${language}:${messages.selectionMenu.commands.improveClarity.ariaLabel}`,
            command: "Feature command",
            icon: "wand",
            id: "feature.command",
            label: "Feature",
          },
        ],
      }),
    ]);

    const contributions = registry.resolve(resolveInput);

    expect(contributions.tiptapExtensions).toEqual([tiptapExtension]);
    expect(contributions.slashCommands.map((item) => item.id)).toEqual(["core.a"]);
    expect(contributions.selectionCommands.map((item) => item.ariaLabel)).toEqual(["ko:명확하게 개선"]);
  });

  it("throws on duplicate contribution ids", () => {
    const registry = createEditorPluginRegistry([
      plugin("a", {
        slashCommands: () => [
          {
            aliases: ["a"],
            command: () => {},
            group: "blocks",
            icon: "type",
            id: "duplicate.command",
            label: "A",
            searchText: "a",
            subtext: "A command",
          },
        ],
      }),
      plugin("b", {
        slashCommands: () => [
          {
            aliases: ["b"],
            command: () => {},
            group: "blocks",
            icon: "type",
            id: "duplicate.command",
            label: "B",
            searchText: "b",
            subtext: "B command",
          },
        ],
      }),
    ]);

    expect(() => registry.resolve(resolveInput)).toThrow(
      /Duplicate editor plugin contribution id in slashCommands: duplicate.command/,
    );
  });

  it("keeps the core document plugin server-safe and self-contained", () => {
    const registry = createEditorPluginRegistry([coreDocumentPlugin]);
    const extensionNames = registry.resolve(resolveInput).tiptapExtensions.map((extension) => extension.name);

    expect(extensionNames).toContain("starterKit");
    expect(extensionNames).toContain("link");
    expect(extensionNames).toContain("emptyListItemExit");
  });
});
