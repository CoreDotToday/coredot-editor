# Editor Plugin Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static, typed editor plugin layer so downstream projects can add Tiptap extensions, selection AI commands, and slash menu items without editing the central editor components.

**Architecture:** Keep Tiptap as the editor engine and add `src/plugins` as the app-level contribution registry. Built-in features move behind plugin declarations, while compatibility wrappers preserve existing imports and behavior during the migration.

**Tech Stack:** Next.js, React, Tiptap, TypeScript, Vitest, Playwright, Testing Library.

---

## Plan Review Amendments

Subagent review found a few integration risks in the first draft. These amendments override the detailed steps below where they differ:

- `EditorPluginContext` must include localized `messages`, `featureFlags`, and the enabled plugin id list. Plugins should not import global i18n data when context already supplies the active language copy.
- `createDocumentSchemaExtensions()` must remain server-safe for DOCX import/export. It should call only the core document plugin, not `defaultEditorPlugins`, React hooks, or UI plugin modules.
- `src/plugins/use-editor-plugins.ts` is a real integration helper. `DocumentEditor` should consume resolved contributions from this hook and may accept explicit `pluginContributions` for focused tests or downstream embedding.
- Slash menu AI commands need runtime callbacks, so the built-in slash plugin provides static editor commands and `DocumentEditor` appends callback-bound AI commands at render time.
- Block controls are reserved in the public type surface, but this pass does not move `BlockGutterControls` behind plugin rendering. That avoids a partial block-action migration without tests.
- Slash command handlers should be isolated so a plugin command failure is logged and the editor shell does not crash.
- Tests must cover registry validation, server-safe document schema compatibility, externally supplied selection commands, externally supplied slash commands, and focused existing conversion/target tests.

## File Structure

- Create `src/plugins/types.ts`: public plugin interfaces and contribution types.
- Create `src/plugins/registry.ts`: plugin validation, dependency ordering, and contribution resolution.
- Create `src/plugins/registry.test.ts`: registry TDD coverage.
- Create `src/plugins/builtin/core-document-plugin.ts`: built-in Tiptap schema/behavior extensions.
- Create `src/plugins/builtin/ai-writing-plugin.ts`: built-in selection AI commands.
- Create `src/plugins/builtin/slash-menu-plugin.ts`: built-in slash menu commands.
- Create `src/plugins/builtin/index.ts`: built-in plugin list.
- Create `src/plugins/app-plugins.ts`: downstream extension seam.
- Create `src/plugins/use-editor-plugins.ts`: React helper for resolving current-language contributions.
- Modify `src/features/documents/tiptap-extensions.ts`: preserve compatibility through the plugin registry.
- Modify `src/components/document/SelectionAiMenu.tsx`: render plugin-provided selection commands.
- Modify `src/components/document/SlashCommandMenu.tsx`: render plugin-provided slash command items.
- Modify `src/components/document/DocumentEditor.tsx`: consume resolved plugin contributions.
- Modify `src/components/document/SelectionAiMenu.test.tsx` if present, otherwise add coverage in `DocumentEditor.test.tsx`.
- Modify `src/components/document/SlashCommandMenu.test.tsx`: verify externally provided slash command items render and execute.
- Create `docs/PLUGINS.md`: plugin authoring guide.
- Modify `docs/ARCHITECTURE.md`: document the plugin extension point.

---

### Task 1: Registry And Public Types

**Files:**
- Create: `src/plugins/types.ts`
- Create: `src/plugins/registry.ts`
- Create: `src/plugins/registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Add `src/plugins/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
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
    expect(registry.resolve({ language: "ko" }).selectionCommands.map((item) => item.id)).toEqual([
      "enabled.command",
    ]);
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

  it("flattens contributions deterministically", () => {
    const registry = createEditorPluginRegistry([
      plugin("core", {
        slashCommands: () => [
          {
            aliases: ["a"],
            command: () => {},
            group: "blocks",
            icon: "type",
            id: "core.a",
            label: "A",
            searchText: "a",
            subtext: "A command",
          },
        ],
      }),
      plugin("feature", {
        dependencies: ["core"],
        slashCommands: () => [
          {
            aliases: ["b"],
            command: () => {},
            group: "blocks",
            icon: "type",
            id: "feature.b",
            label: "B",
            searchText: "b",
            subtext: "B command",
          },
        ],
      }),
    ]);

    expect(registry.resolve({ language: "ko" }).slashCommands.map((item) => item.id)).toEqual([
      "core.a",
      "feature.b",
    ]);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm vitest run src/plugins/registry.test.ts
```

Expected: fail because `src/plugins/registry.ts` and `src/plugins/types.ts` do not exist.

- [ ] **Step 3: Implement public types**

Create `src/plugins/types.ts`:

```ts
import type { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { EditorLanguage } from "@/features/i18n/editor-language";

export type EditorPluginContext = {
  enabledPluginIds: string[];
  language: EditorLanguage;
};

export type EditorSelectionCommandIcon =
  | "barChart"
  | "languages"
  | "minimize"
  | "pen"
  | "sparkles"
  | "wand";

export type EditorSlashCommandIcon =
  | "checkSquare"
  | "code"
  | "heading1"
  | "heading2"
  | "heading3"
  | "list"
  | "listOrdered"
  | "minus"
  | "quote"
  | "sparkles"
  | "type";

export type EditorSlashCommandRange = {
  from: number;
  to: number;
};

export type EditorSelectionCommand = {
  ariaLabel?: string;
  command: string;
  icon: EditorSelectionCommandIcon;
  id: string;
  label: string;
};

export type EditorSlashCommand = {
  aliases: string[];
  command: (editor: Editor, range: EditorSlashCommandRange) => void;
  group: "ai" | "blocks" | "lists" | "style";
  icon: EditorSlashCommandIcon;
  id: string;
  label: string;
  searchText: string;
  subtext: string;
};

export type EditorBlockAction = {
  id: string;
  label: string;
};

export type EditorToolbarItem = {
  id: string;
  label: string;
};

export type EditorWorkspacePanel = {
  id: string;
  label: string;
};

export type EditorSettingsSection = {
  id: string;
  label: string;
};

export type EditorPlugin = {
  blockActions?: (context: EditorPluginContext) => EditorBlockAction[];
  dependencies?: string[];
  enabledByDefault?: boolean;
  id: string;
  name: string;
  selectionCommands?: (context: EditorPluginContext) => EditorSelectionCommand[];
  settingsSections?: (context: EditorPluginContext) => EditorSettingsSection[];
  slashCommands?: (context: EditorPluginContext) => EditorSlashCommand[];
  tiptapExtensions?: (context: EditorPluginContext) => Extension[];
  toolbarItems?: (context: EditorPluginContext) => EditorToolbarItem[];
  version: string;
  workspacePanels?: (context: EditorPluginContext) => EditorWorkspacePanel[];
};

export type EditorPluginContributions = {
  blockActions: EditorBlockAction[];
  selectionCommands: EditorSelectionCommand[];
  settingsSections: EditorSettingsSection[];
  slashCommands: EditorSlashCommand[];
  tiptapExtensions: Extension[];
  toolbarItems: EditorToolbarItem[];
  workspacePanels: EditorWorkspacePanel[];
};
```

- [ ] **Step 4: Implement registry**

Create `src/plugins/registry.ts`:

```ts
import type { EditorLanguage } from "@/features/i18n/editor-language";
import type { EditorPlugin, EditorPluginContext, EditorPluginContributions } from "./types";

type EditorPluginRegistryOptions = {
  disabledPluginIds?: string[];
};

type ResolveInput = {
  language: EditorLanguage;
};

export type EditorPluginRegistry = {
  plugins: EditorPlugin[];
  resolve: (input: ResolveInput) => EditorPluginContributions;
};

export function createEditorPluginRegistry(
  plugins: EditorPlugin[],
  options: EditorPluginRegistryOptions = {},
): EditorPluginRegistry {
  const disabledPluginIds = new Set(options.disabledPluginIds ?? []);
  const pluginMap = new Map<string, EditorPlugin>();

  for (const currentPlugin of plugins) {
    if (pluginMap.has(currentPlugin.id)) {
      throw new Error(`Duplicate editor plugin id: ${currentPlugin.id}`);
    }

    pluginMap.set(currentPlugin.id, currentPlugin);
  }

  const enabledPlugins = plugins.filter((currentPlugin) => {
    if (disabledPluginIds.has(currentPlugin.id)) return false;
    return currentPlugin.enabledByDefault !== false;
  });
  const enabledPluginMap = new Map(enabledPlugins.map((currentPlugin) => [currentPlugin.id, currentPlugin]));
  const sortedPlugins = sortPluginsByDependency(enabledPlugins, enabledPluginMap);

  return {
    plugins: sortedPlugins,
    resolve: ({ language }) => resolvePluginContributions(sortedPlugins, language),
  };
}

function sortPluginsByDependency(plugins: EditorPlugin[], pluginMap: Map<string, EditorPlugin>) {
  const sortedPlugins: EditorPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (currentPlugin: EditorPlugin, ancestry: string[]) => {
    if (visited.has(currentPlugin.id)) return;
    if (visiting.has(currentPlugin.id)) {
      throw new Error(`Cyclic editor plugin dependency: ${[...ancestry, currentPlugin.id].join(" -> ")}`);
    }

    visiting.add(currentPlugin.id);

    for (const dependencyId of currentPlugin.dependencies ?? []) {
      const dependency = pluginMap.get(dependencyId);
      if (!dependency) {
        throw new Error(`Editor plugin ${currentPlugin.id} depends on missing plugin: ${dependencyId}`);
      }
      visit(dependency, [...ancestry, currentPlugin.id]);
    }

    visiting.delete(currentPlugin.id);
    visited.add(currentPlugin.id);
    sortedPlugins.push(currentPlugin);
  };

  for (const currentPlugin of plugins) {
    visit(currentPlugin, []);
  }

  return sortedPlugins;
}

function resolvePluginContributions(plugins: EditorPlugin[], language: EditorLanguage): EditorPluginContributions {
  const context: EditorPluginContext = {
    enabledPluginIds: plugins.map((plugin) => plugin.id),
    language,
  };

  return {
    blockActions: plugins.flatMap((plugin) => plugin.blockActions?.(context) ?? []),
    selectionCommands: plugins.flatMap((plugin) => plugin.selectionCommands?.(context) ?? []),
    settingsSections: plugins.flatMap((plugin) => plugin.settingsSections?.(context) ?? []),
    slashCommands: plugins.flatMap((plugin) => plugin.slashCommands?.(context) ?? []),
    tiptapExtensions: plugins.flatMap((plugin) => plugin.tiptapExtensions?.(context) ?? []),
    toolbarItems: plugins.flatMap((plugin) => plugin.toolbarItems?.(context) ?? []),
    workspacePanels: plugins.flatMap((plugin) => plugin.workspacePanels?.(context) ?? []),
  };
}
```

- [ ] **Step 5: Run registry tests**

Run:

```bash
pnpm vitest run src/plugins/registry.test.ts
```

Expected: pass.

---

### Task 2: Built-In Core Document Plugin

**Files:**
- Create: `src/plugins/builtin/core-document-plugin.ts`
- Create: `src/plugins/builtin/index.ts`
- Create: `src/plugins/app-plugins.ts`
- Modify: `src/features/documents/tiptap-extensions.ts`
- Test: `src/plugins/registry.test.ts`

- [ ] **Step 1: Add a failing compatibility test**

Append to `src/plugins/registry.test.ts`:

```ts
import { defaultEditorPlugins } from "./app-plugins";

it("ships core document extensions through the default plugin list", () => {
  const registry = createEditorPluginRegistry(defaultEditorPlugins);
  const extensionNames = registry.resolve({ language: "ko" }).tiptapExtensions.map((extension) => extension.name);

  expect(extensionNames).toContain("starterKit");
  expect(extensionNames).toContain("link");
  expect(extensionNames).toContain("emptyListItemExit");
});
```

Run:

```bash
pnpm vitest run src/plugins/registry.test.ts
```

Expected: fail because built-in plugins do not exist.

- [ ] **Step 2: Move current schema extensions into a core plugin**

Create `src/plugins/builtin/core-document-plugin.ts` by moving the current extension construction from `src/features/documents/tiptap-extensions.ts`:

```ts
import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownPaste } from "@/features/documents/markdown-paste";
import type { EditorPlugin } from "../types";

export const coreDocumentPlugin: EditorPlugin = {
  id: "core-document",
  name: "Core Document",
  version: "0.1.0",
  tiptapExtensions: () => [
    StarterKit.configure({
      link: false,
    }),
    Link.configure({
      autolink: true,
      openOnClick: false,
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    TableKit.configure({
      table: {
        resizable: true,
      },
    }),
    MarkdownPaste,
    Typography,
    EmptyListItemExit,
  ],
};

const EmptyListItemExit = Extension.create({
  name: "emptyListItemExit",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection } = this.editor.state;
        if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.textContent.length > 0) {
          return false;
        }

        const listItemType = findActiveListItemType(selection.$from);
        if (!listItemType) {
          return false;
        }

        const commands = this.editor.commands as unknown as Record<string, (...commandArgs: unknown[]) => boolean>;
        return commands.liftListItem?.(listItemType) ?? false;
      },
    };
  },
});

function findActiveListItemType($from: { depth: number; node: (depth: number) => { type: { name: string } } }) {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name;
    if (nodeName === "listItem" || nodeName === "taskItem") {
      return nodeName;
    }
  }

  return null;
}
```

- [ ] **Step 3: Add built-in and app plugin lists**

Create `src/plugins/builtin/index.ts`:

```ts
import { coreDocumentPlugin } from "./core-document-plugin";
import type { EditorPlugin } from "../types";

export const builtinEditorPlugins: EditorPlugin[] = [coreDocumentPlugin];
```

Create `src/plugins/app-plugins.ts`:

```ts
import { builtinEditorPlugins } from "./builtin";
import type { EditorPlugin } from "./types";

export const appEditorPlugins: EditorPlugin[] = [];
export const defaultEditorPlugins: EditorPlugin[] = [...builtinEditorPlugins, ...appEditorPlugins];
```

- [ ] **Step 4: Preserve `createDocumentSchemaExtensions()` compatibility**

Replace `src/features/documents/tiptap-extensions.ts` with a compatibility wrapper:

```ts
import { createEditorPluginRegistry } from "@/plugins/registry";
import { defaultEditorPlugins } from "@/plugins/app-plugins";

export function createDocumentSchemaExtensions() {
  return createEditorPluginRegistry(defaultEditorPlugins).resolve({ language: "ko" }).tiptapExtensions;
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run src/plugins/registry.test.ts src/features/documents/markdown-paste.test.ts src/components/document/notion-mod-a-selection.test.ts
```

Expected: pass.

---

### Task 3: Selection AI Commands As Plugins

**Files:**
- Create: `src/plugins/builtin/ai-writing-plugin.ts`
- Modify: `src/plugins/builtin/index.ts`
- Modify: `src/components/document/SelectionAiMenu.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`
- Test: `src/components/document/DocumentEditor.test.tsx`

- [ ] **Step 1: Write failing component test**

Append to `src/components/document/DocumentEditor.test.tsx`:

```ts
it("renders selection AI commands contributed by editor plugins", async () => {
  render(
    <DocumentEditor
      contentJson={{
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Selected plugin text." }] }],
      }}
      pluginContributions={{
        blockActions: [],
        selectionCommands: [
          {
            command: "Plugin rewrite",
            icon: "sparkles",
            id: "test.pluginRewrite",
            label: "플러그인 개선",
          },
        ],
        settingsSections: [],
        slashCommands: [],
        tiptapExtensions: [],
        toolbarItems: [],
        workspacePanels: [],
      }}
      onChange={() => {}}
      onSelectionCommand={vi.fn()}
      title="Plugin test"
    />,
  );

  const editor = screen.getByRole("textbox", { name: "문서 본문" });
  await userEvent.click(editor);
  await userEvent.keyboard("{Meta>}a{/Meta}");

  expect(await screen.findByRole("button", { name: "플러그인 개선" })).toBeInTheDocument();
});
```

If the existing test helper uses `ControlOrMeta+A`, use the local pattern instead of the literal keyboard call above.

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx
```

Expected: fail because `DocumentEditor` does not accept `pluginContributions`.

- [ ] **Step 2: Add built-in AI writing plugin**

Create `src/plugins/builtin/ai-writing-plugin.ts`:

```ts
import { editorMessages } from "@/features/i18n/editor-language";
import type { EditorPlugin } from "../types";

export const aiWritingPlugin: EditorPlugin = {
  id: "ai-writing",
  name: "AI Writing",
  version: "0.1.0",
  selectionCommands: ({ language }) => {
    const messages = editorMessages[language].selectionMenu.commands;
    return [
      {
        ariaLabel: messages.improveClarity.ariaLabel,
        command: "Improve clarity",
        icon: "wand",
        id: "ai.improveClarity",
        label: messages.improveClarity.label,
      },
      {
        ariaLabel: messages.makeConcise.ariaLabel,
        command: "Make concise",
        icon: "minimize",
        id: "ai.makeConcise",
        label: messages.makeConcise.label,
      },
      {
        ariaLabel: messages.makeStrategic.ariaLabel,
        command: "Make more strategic",
        icon: "sparkles",
        id: "ai.makeStrategic",
        label: messages.makeStrategic.label,
      },
      {
        ariaLabel: messages.strengthenEvidence.ariaLabel,
        command: "Strengthen evidence",
        icon: "barChart",
        id: "ai.strengthenEvidence",
        label: messages.strengthenEvidence.label,
      },
      {
        ariaLabel: messages.continueWriting.ariaLabel,
        command: "Continue writing",
        icon: "pen",
        id: "ai.continueWriting",
        label: messages.continueWriting.label,
      },
      {
        ariaLabel: messages.translateKorean.ariaLabel,
        command: "Translate to Korean",
        icon: "languages",
        id: "ai.translateKorean",
        label: messages.translateKorean.label,
      },
      {
        ariaLabel: messages.translateEnglish.ariaLabel,
        command: "Translate to English",
        icon: "languages",
        id: "ai.translateEnglish",
        label: messages.translateEnglish.label,
      },
    ];
  },
};
```

Add it to `src/plugins/builtin/index.ts` after `coreDocumentPlugin`.

- [ ] **Step 3: Make `SelectionAiMenu` render contributed commands**

In `src/components/document/SelectionAiMenu.tsx`:

1. Import `EditorSelectionCommand`.
2. Replace the local `commands` array with an icon map:

```ts
import type { EditorSelectionCommand, EditorSelectionCommandIcon } from "@/plugins/types";

const commandIconMap = {
  barChart: BarChart3,
  languages: Languages,
  minimize: Minimize2,
  pen: PenLine,
  sparkles: Sparkles,
  wand: Wand2,
} satisfies Record<EditorSelectionCommandIcon, typeof Wand2>;
```

3. Add prop:

```ts
commands: EditorSelectionCommand[];
```

4. Render `commands.map((item) => ...)`, use `commandIconMap[item.icon]`, `item.ariaLabel ?? item.label`, and `item.command`.
5. Change `getCommandLabel(command, messages)` to `getCommandLabel(command, commands)`.

- [ ] **Step 4: Wire `DocumentEditor` to accept plugin contributions**

In `src/components/document/DocumentEditor.tsx`:

1. Import `EditorPluginContributions`.
2. Add optional prop:

```ts
pluginContributions?: EditorPluginContributions;
```

3. Create fallback contributions with current behavior:

```ts
const defaultPluginContributions = useMemo(
  () => createEditorPluginRegistry(defaultEditorPlugins).resolve({ language }),
  [language],
);
const resolvedPluginContributions = pluginContributions ?? defaultPluginContributions;
```

4. Replace `...createDocumentSchemaExtensions()` with `...resolvedPluginContributions.tiptapExtensions`.
5. Pass `resolvedPluginContributions.selectionCommands` to `SelectionAiMenu`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx src/components/document/DocumentShell.test.tsx
```

Expected: pass.

---

### Task 4: Slash Menu Commands As Plugins

**Files:**
- Create: `src/plugins/builtin/slash-menu-plugin.ts`
- Modify: `src/plugins/builtin/index.ts`
- Modify: `src/components/document/SlashCommandMenu.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`
- Test: `src/components/document/SlashCommandMenu.test.tsx`

- [ ] **Step 1: Write failing slash menu test**

Append to `src/components/document/SlashCommandMenu.test.tsx`:

```ts
it("renders externally supplied slash command items", async () => {
  const onPluginCommand = vi.fn();
  renderSlashCommandMenu({
    slashCommands: [
      {
        aliases: ["plugin"],
        command: () => onPluginCommand(),
        group: "blocks",
        icon: "sparkles",
        id: "plugin.custom",
        label: "Plugin block",
        searchText: "plugin block",
        subtext: "Inserted by a plugin",
      },
    ],
  });

  await typeSlashQuery("/plugin");
  await userEvent.click(await screen.findByRole("option", { name: /Plugin block/ }));

  expect(onPluginCommand).toHaveBeenCalledTimes(1);
});
```

Use the existing local helper names in `SlashCommandMenu.test.tsx`; if they differ, adapt only the helper calls and keep the assertion intent.

Run:

```bash
pnpm vitest run src/components/document/SlashCommandMenu.test.tsx
```

Expected: fail because `SlashCommandMenu` does not accept external slash commands.

- [ ] **Step 2: Add built-in slash menu plugin**

Create `src/plugins/builtin/slash-menu-plugin.ts` with the current item definitions from `createSlashCommandItems()`. The exported plugin should depend on `core-document` and expose:

```ts
export function createDefaultSlashCommands(language: EditorLanguage, onAiCommand?: (command: string) => void): EditorSlashCommand[] {
  // current createSlashCommandItems body, with string icon ids instead of Lucide components
}

export const slashMenuPlugin: EditorPlugin = {
  id: "slash-menu",
  name: "Slash Menu",
  version: "0.1.0",
  dependencies: ["core-document"],
  slashCommands: ({ language }) => createDefaultSlashCommands(language),
};
```

Because the AI slash command needs `onAiCommand`, keep `createDefaultSlashCommands()` exported and let `DocumentEditor` append the AI-aware items from the resolved helper.

- [ ] **Step 3: Let `SlashCommandMenu` accept commands**

In `src/components/document/SlashCommandMenu.tsx`:

1. Import `EditorSlashCommand` and `EditorSlashCommandIcon`.
2. Replace `SlashCommandItem` icon component type with string icon id.
3. Add an icon map:

```ts
const slashCommandIconMap = {
  checkSquare: CheckSquare,
  code: Code2,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  list: List,
  listOrdered: ListOrdered,
  minus: Minus,
  quote: Quote,
  sparkles: Sparkles,
  type: Type,
} satisfies Record<EditorSlashCommandIcon, typeof Type>;
```

4. Add prop:

```ts
slashCommands?: EditorSlashCommand[];
```

5. Set:

```ts
const allItems = useMemo(
  () => slashCommands ?? createSlashCommandItems(language, onAiCommand),
  [language, onAiCommand, slashCommands],
);
```

6. Render icon via `slashCommandIconMap[item.icon]`.

- [ ] **Step 4: Pass plugin slash commands from `DocumentEditor`**

In `DocumentEditor`, pass `resolvedPluginContributions.slashCommands` to `SlashCommandMenu`.

If the default plugin slash command list does not include the AI continue command because it needs `onAiCommand`, append an `ai_continue` item in `DocumentEditor` using an exported helper from `slash-menu-plugin`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run src/components/document/SlashCommandMenu.test.tsx src/components/document/DocumentEditor.test.tsx
```

Expected: pass.

---

### Task 5: Docs And Architecture Notes

**Files:**
- Create: `docs/PLUGINS.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Add plugin documentation**

Create `docs/PLUGINS.md`:

```md
# Editor Plugins

Coredot Editor supports statically registered editor plugins. Plugins are normal TypeScript modules that contribute Tiptap extensions, slash menu items, selection AI commands, and future editor UI surfaces.

Runtime loading of untrusted plugin packages is intentionally not supported. Register plugins at build time in `src/plugins/app-plugins.ts` so Next.js can bundle them and so plugin code can be reviewed.

## Creating A Plugin

```ts
import type { EditorPlugin } from "@/plugins/types";

export const examplePlugin: EditorPlugin = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  selectionCommands: () => [
    {
      command: "Rewrite as an action plan",
      icon: "sparkles",
      id: "example.actionPlan",
      label: "Action plan",
    },
  ],
  slashCommands: () => [
    {
      aliases: ["action", "plan"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).insertContent("Action plan: ").run();
      },
      group: "blocks",
      icon: "sparkles",
      id: "example.actionPlanSlash",
      label: "Action plan",
      searchText: "action plan",
      subtext: "Insert an action plan starter",
    },
  ],
};
```

## Registering A Plugin

Add the plugin to `src/plugins/app-plugins.ts`:

```ts
import { examplePlugin } from "./example-plugin";
import { builtinEditorPlugins } from "./builtin";
import type { EditorPlugin } from "./types";

export const appEditorPlugins: EditorPlugin[] = [examplePlugin];
export const defaultEditorPlugins: EditorPlugin[] = [...builtinEditorPlugins, ...appEditorPlugins];
```

## Contribution Points

- `tiptapExtensions`: low-level Tiptap/ProseMirror behavior.
- `selectionCommands`: buttons in the floating selection AI menu.
- `slashCommands`: entries in the `/` menu.
- `blockActions`, `toolbarItems`, `workspacePanels`, and `settingsSections`: reserved typed extension points that will be wired more deeply as the product grows.

## Rules

- Plugin ids must be unique.
- Dependencies must point to enabled plugins.
- Cyclic dependencies fail during registry creation.
- Keep plugin code deterministic and avoid direct access to server secrets.
- Prefer route handlers or provider contracts for server-side work.
```

- [ ] **Step 2: Update architecture docs**

Add this section to `docs/ARCHITECTURE.md` before `## Extension Points`:

```md
## Editor Plugin Layer

`src/plugins/` is the app-level extension layer above Tiptap. Tiptap remains the editor engine, while Coredot plugins group engine extensions and React-facing contributions such as selection AI commands and slash menu items.

Plugins are statically registered through `src/plugins/app-plugins.ts`. This keeps downstream extension straightforward for open-source users while avoiding runtime execution of untrusted plugin code.
```

- [ ] **Step 3: Run documentation checks**

Run:

```bash
rg "Editor Plugin Layer|Creating A Plugin|Runtime loading" docs/PLUGINS.md docs/ARCHITECTURE.md
```

Expected: all three strings are found.

---

### Task 6: Final Verification

**Files:**
- No new source files unless previous tasks require fixes.

- [ ] **Step 1: Run full verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm security:audit
git diff --check
rg "cdt_" --glob '!.env*' .
```

Expected:

- lint exits 0
- typecheck exits 0
- unit tests pass
- e2e tests pass
- build exits 0
- security audit reports no known vulnerabilities
- `git diff --check` exits 0
- `rg "cdt_" --glob '!.env*' .` exits 1 with no matches

- [ ] **Step 2: Browser smoke test**

Open `http://localhost:3000/documents/dtRXj0xZ_BTDDt2d-hKW4` in the in-app browser and confirm:

- document editor loads
- selecting text shows built-in AI commands
- `/` menu shows built-in slash commands
- mobile viewport still has no horizontal overflow

- [ ] **Step 3: Review implementation against spec**

Check the acceptance criteria in `docs/superpowers/specs/2026-05-23-editor-plugin-architecture-design.md`:

- local plugin can be added through `app-plugins.ts`
- plugin can add Tiptap extension, slash item, and selection command
- existing behavior remains unchanged
- registry failures are tested
- docs explain plugin authoring
