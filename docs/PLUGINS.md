# Editor Plugins

Coredot Editor exposes a static, build-time plugin layer for product teams that need editor behavior without adding branches throughout `DocumentEditor`, the command menus, gutters, Workspace, or settings surface. There is no runtime third-party loader; registration stays reviewable in source control.

## Contributions

Every public contribution type has a host:

- Tiptap extensions for schema, input rules, paste handlers, shortcuts, and ProseMirror plugins.
- Selection AI commands.
- Slash commands.
- Toolbar items.
- Block actions.
- Workspace panels.
- Settings sections.

Factories, command handlers, and React render contributions are isolated by the host. A failing contribution is reported with its stable ID without taking down the rest of the editor.

## File Map

- `src/plugins/types.ts`: public contribution and host-context interfaces.
- `src/plugins/registry.ts`: validation, dependency ordering, enablement, and resolution.
- `src/plugins/builtin/`: built-in document, AI-writing, and slash-menu plugins.
- `src/plugins/app-plugins.ts`: `createAppEditorPlugins()` composition seam.
- `src/plugins/app-document-schema-profile-runtime.mjs`: shared React-free browser/DOCX schema selection.
- `src/plugins/document-schema-profile.ts`: typed editor/server schema helpers.
- `src/plugins/use-editor-plugins.ts`: React resolution helper.

## Add A Plugin

Create a plugin module:

```ts
import { Extension } from "@tiptap/core";
import type { EditorPlugin } from "@/plugins/types";

export const legalRiskPlugin: EditorPlugin = {
  dependencies: ["core.document"],
  id: "legal.risk",
  name: "Legal risk drafting tools",
  selectionCommands: () => [
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
  tiptapExtensions: () => [Extension.create({ name: "legalRiskCommands" })],
  version: "0.1.0",
};
```

Register it through the existing app composition rather than constructing a parallel default list:

```ts
import { createBuiltinEditorPlugins } from "./builtin";
import { appDocumentSchemaProfileRuntime } from "./app-document-schema-profile-runtime.mjs";
import type { DocumentSchemaProfile } from "./document-schema-profile";
import { legalRiskPlugin } from "./legal-risk-plugin";
import type { EditorPlugin } from "./types";

export const appDocumentSchemaProfile: DocumentSchemaProfile =
  appDocumentSchemaProfileRuntime;

export const appEditorPlugins: EditorPlugin[] = [legalRiskPlugin];

type CreateAppEditorPluginsOptions = {
  appPlugins?: EditorPlugin[];
  schemaProfile?: DocumentSchemaProfile;
};

export function createAppEditorPlugins({
  appPlugins = appEditorPlugins,
  schemaProfile = appDocumentSchemaProfile,
}: CreateAppEditorPluginsOptions = {}): EditorPlugin[] {
  return [...createBuiltinEditorPlugins(schemaProfile), ...appPlugins];
}

export const defaultEditorPlugins: EditorPlugin[] = createAppEditorPlugins();
```

This preserves dependency ordering and ensures the core document plugin receives the same app schema Profile used by document interchange.

## Shared Document Schema Profile

Editor UI plugins and the document schema have different runtime constraints. UI contributions may import React/browser code. The schema used by the editor and DOCX worker must remain React-free.

`src/plugins/app-document-schema-profile-runtime.mjs` is the single build-time selection seam:

```js
import { defaultDocumentSchemaProfileRuntime } from "./document-schema-profile-runtime.mjs";

export const appDocumentSchemaProfileRuntime = defaultDocumentSchemaProfileRuntime;
```

To add persistent document nodes, replace that value with a React-free Profile whose stable `id` and `extensions()` work in both the browser editor and Node conversion worker. `createAppEditorPlugins()` passes it to the built-in core document plugin, while DOCX conversion imports the same runtime Profile directly. Do not maintain a separate server-safe extension list; two lists can drift and silently remove downstream nodes during interchange.

A UI-only plugin can stay in `appEditorPlugins`. A Tiptap extension that changes persisted schema belongs in the shared app document schema Profile, even when a plugin also contributes commands or panels for that node.

## Plugin Rules

- Keep plugin and contribution IDs unique and stable. The registry rejects duplicates.
- Declare dependency IDs explicitly.
- Use stable English AI `command` values; localize UI labels through `EditorPluginContext.messages`.
- Use the host context for toolbar/block actions instead of reaching into `DocumentShell` state.
- Keep settings and Workspace panel focus/Escape behavior inside the shared modal hosts.
- Let hosts isolate errors; do not add global error handlers that swallow contribution IDs.
- Do not access browser globals from the shared document schema Profile.
- Route structural nested-list changes through typed host actions or the pure document transform helpers.

## Block Movement Boundary

Plugins should not rewrite nested-list JSON directly. Prefer:

1. A Tiptap command for behavior local to the current selection.
2. A typed host block action for gutter/menu behavior.
3. A covered pure transform in `src/features/documents/tiptap-blocks.ts` when structure changes.

This keeps movement consistent with stale drag-session guards, normalized ranges, validated destinations, and focus restoration.

## Test Checklist

Run registry and every affected host test, not only the plugin factory:

```bash
pnpm vitest run src/plugins/registry.test.ts
pnpm vitest run src/plugins/document-schema-profile.test.ts
pnpm vitest run src/components/document/DocumentEditor.test.tsx
pnpm vitest run src/components/document/DocumentShell.test.tsx
pnpm typecheck
```

If persisted schema or DOCX behavior changes, also run the conversion corpus tests and the full release gate:

```bash
pnpm vitest run src/features/documents/docx-conversion.test.ts
pnpm release:check
pnpm e2e:production
```

Production-build commands require the verification-only Clerk environment documented in [Configuration](configuration.md#production-verification), or real Clerk credentials for a deployment build.
