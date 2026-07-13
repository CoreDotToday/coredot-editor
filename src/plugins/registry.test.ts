import { Extension } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { editorMessages } from "@/features/i18n/editor-language";
import { coreDocumentPlugin } from "./builtin/core-document-plugin";
import { createEditorPluginRegistry, mergeEditorPluginContributions } from "./registry";
import { createEmptyEditorPluginContributions, type EditorPlugin, type EditorPluginContributions } from "./types";

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

  it("resolves every executable and rendered contribution type", () => {
    const registry = createEditorPluginRegistry([
      plugin("complete", {
        blockActions: () => [{ id: "complete.block", label: "Plugin block action", run: () => undefined }],
        settingsSections: () => [{ id: "complete.settings", label: "Plugin settings", render: () => null }],
        toolbarItems: () => [{ id: "complete.toolbar", label: "Plugin toolbar action", run: () => undefined }],
        workspacePanels: () => [{ id: "complete.workspace", label: "Plugin workspace", render: () => null }],
      }),
    ]);

    const contributions = registry.resolve(resolveInput);

    expect(contributions.toolbarItems[0]).toMatchObject({ id: "complete.toolbar", label: "Plugin toolbar action" });
    expect(contributions.blockActions[0]).toMatchObject({ id: "complete.block", label: "Plugin block action" });
    expect(contributions.workspacePanels[0]).toMatchObject({ id: "complete.workspace", label: "Plugin workspace" });
    expect(contributions.settingsSections[0]).toMatchObject({ id: "complete.settings", label: "Plugin settings" });
  });

  it("isolates a failed contribution factory and logs only safe plugin identity", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = createEditorPluginRegistry([
      plugin("broken", {
        toolbarItems: () => {
          throw new Error("secret document text");
        },
      }),
      plugin("healthy", {
        toolbarItems: () => [{ id: "healthy.toolbar", label: "Healthy", run: () => undefined }],
      }),
    ]);

    expect(registry.resolve(resolveInput).toolbarItems.map((item) => item.id)).toEqual(["healthy.toolbar"]);
    expect(consoleError).toHaveBeenCalledWith("Editor plugin contribution factory failed.", {
      contributionType: "toolbarItems",
      pluginId: "broken",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret document text");
    consoleError.mockRestore();
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

  it.each([
    "selectionCommands",
    "slashCommands",
    "toolbarItems",
    "blockActions",
    "workspacePanels",
    "settingsSections",
  ] as const)("rejects duplicate %s ids when merging pre-resolved contributions", (contributionType) => {
    const base = createEmptyEditorPluginContributions();
    (base[contributionType] as unknown as Array<{ id: string }>).push({ id: "duplicate.contribution" });
    const additional = {
      [contributionType]: [{ id: "duplicate.contribution" }],
    } as unknown as Partial<EditorPluginContributions>;

    expect(() => mergeEditorPluginContributions(base, additional)).toThrow(
      new RegExp(`Duplicate editor plugin contribution id in ${contributionType}: duplicate\\.contribution`),
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
