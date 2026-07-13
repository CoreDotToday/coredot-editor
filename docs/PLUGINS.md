# Editor Plugins

Coredot Editor exposes a small static plugin layer for product teams that want to add editor behavior without editing `DocumentEditor`, `SelectionAiMenu`, or `SlashCommandMenu` directly.

The plugin layer is intentionally static for now. Plugins are imported at build time, sorted by dependency, and resolved with the active editor language pack. This keeps the open-source starter easy to audit and avoids runtime plugin loading security issues.

## What Plugins Can Add

Current plugin contributions:

- Tiptap extensions for schema, input rules, paste handlers, keyboard shortcuts, and ProseMirror plugins
- Selection AI commands shown in the floating selection menu
- Slash menu commands shown when users type `/`
- Toolbar items rendered in the editor toolbar
- Block actions rendered in the block gutter
- Workspace panels rendered as AI workspace tabs
- Settings sections rendered inside the shared settings modal

## File Map

- `src/plugins/types.ts`: public plugin interfaces
- `src/plugins/registry.ts`: validation, dependency ordering, and contribution resolution
- `src/plugins/builtin/`: built-in Coredot plugins
- `src/plugins/app-plugins.ts`: project-specific plugin seam
- `src/plugins/use-editor-plugins.ts`: React helper used by `DocumentEditor`

## Add A Plugin

Create a plugin module:

```ts
import { Extension } from "@tiptap/core";
import type { EditorPlugin } from "@/plugins/types";

export const legalRiskPlugin: EditorPlugin = {
  dependencies: ["core.document"],
  id: "legal.risk",
  name: "Legal risk drafting tools",
  selectionCommands: ({ messages }) => [
    {
      ariaLabel: "법률 리스크 완화",
      command: "Mitigate legal risk",
      icon: "sparkles",
      id: "legal.risk.mitigate",
      label: "리스크",
    },
  ],
  slashCommands: () => [
    {
      aliases: ["risk", "legal", "리스크"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).insertContent("리스크 검토: ").run();
      },
      group: "ai",
      icon: "sparkles",
      id: "legal.risk.insert_prompt",
      label: "리스크 검토",
      searchText: "legal risk review",
      subtext: "현재 위치에 리스크 검토 문구를 추가합니다",
    },
  ],
  tiptapExtensions: () => [
    Extension.create({
      name: "legalRiskMetadata",
    }),
  ],
  version: "0.1.0",
};
```

Register it in `src/plugins/app-plugins.ts`:

```ts
import { builtinEditorPlugins } from "./builtin";
import type { EditorPlugin } from "./types";
import { legalRiskPlugin } from "./legal-risk-plugin";

export const appEditorPlugins: EditorPlugin[] = [legalRiskPlugin];

export const defaultEditorPlugins: EditorPlugin[] = [...builtinEditorPlugins, ...appEditorPlugins];
```

## Plugin Rules

- Use stable English `command` strings for AI commands. The UI label can be localized, but the server prompt and history logic expect canonical command text.
- Prefer `messages` from `EditorPluginContext` instead of importing `editorMessages` directly.
- Keep Tiptap schema extensions server-safe. DOCX import/export uses the core document schema outside React.
- Do not access `window`, `document`, React hooks, or browser-only modules from schema plugins that may be used by server routes.
- Keep plugin ids unique and dependency ids explicit.
- Keep contribution ids unique across all enabled plugins. The registry rejects duplicate selection command, slash command, toolbar item, block action, workspace panel, and settings section ids.
- Let command handlers fail locally. The slash menu catches plugin command errors and logs them without crashing the editor shell.
- Keep modal interaction in the host. Settings sections and workspace panels render content inside the shared surface; plugins must not add competing document-level Escape or focus-trap handlers.

## Server-Safe Schema Path

`createDocumentSchemaExtensions()` intentionally calls only the built-in `coreDocumentPlugin`. This keeps DOCX import/export from loading app-level UI plugins or browser-only code.

If a downstream project needs custom schema during DOCX conversion, create a separate server-safe schema plugin list for that route instead of importing the full app plugin list.

## Internal Block Movement Boundaries

Plugins can contribute commands and UI actions, but they should not directly mutate nested-list JSON. Use editor commands exposed by the host application, or add a typed host action first. This keeps block movement consistent with stale-session guards, normalized range resolution, drop-target validation, and the pure transforms in `src/features/documents/tiptap-blocks.ts`.

If a plugin needs new block behavior, prefer this order:

1. Add or reuse a Tiptap command when the behavior is local to the current selection.
2. Add a host-level block action when the behavior belongs in the gutter or slash menu.
3. Extend the pure document transform helpers and cover it with tests when nested-list structure changes.

## Test Checklist

For a new plugin, add focused tests around the contribution type:

```bash
pnpm vitest run src/plugins/registry.test.ts
pnpm vitest run src/components/document/SlashCommandMenu.test.tsx
pnpm vitest run src/components/document/DocumentEditor.test.tsx
pnpm typecheck
```

If the plugin touches document schema or import/export, also run:

```bash
pnpm vitest run src/features/documents/docx-conversion.test.ts
```
