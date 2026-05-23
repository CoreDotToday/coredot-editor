# Editor Plugin Architecture Design

## Context

Coredot Editor currently uses Tiptap directly inside `DocumentEditor` and collects core schema extensions in `createDocumentSchemaExtensions()`. That works for a product prototype, but it makes future features hard to add cleanly because schema extensions, slash commands, AI actions, block controls, toolbar items, workspace panels, settings, and docs are wired in separate places.

The goal is to make editor functionality composable enough for this project and downstream open-source users to add features without editing the central editor files for every change.

## Open Source References

- Tiptap is the closest fit because the app already stores Tiptap JSON and uses Tiptap extensions. Tiptap extensions support commands, keyboard shortcuts, input/paste rules, extension storage, priority ordering, and ProseMirror plugins. This should remain the low-level editor engine extension point.
- ProseMirror provides the underlying plugin model for editor state fields, props, decorations, transaction handling, and schema behavior. It is powerful but too low-level to expose as the only app extension API.
- BlockNote is useful as a Notion-style reference. Its extension and custom schema model shows how block specs, slash menu items, keyboard shortcuts, and ProseMirror/Tiptap plugins can be grouped under one feature-oriented extension.
- Plate is useful as an app-level plugin model reference. Its plugins use stable keys and can carry behavior, options, transforms, components, and state. The app should borrow the feature-module idea, not the Slate dependency.
- Lexical has a clean plugin philosophy around React UI plugins, commands, and nodes. It reinforces that UI and editor engine extensions should be separable.
- Milkdown and Editor.js are less suitable for this codebase because they would push the app toward Markdown-first or block-data-first document models that do not match the existing Tiptap proposal/redline/DOCX flow.

## Design Goals

- Keep Tiptap as the editor engine.
- Add a Coredot-level `EditorPlugin` API that can register both Tiptap extensions and React/UI integration points.
- Make built-in editor features use the same plugin path that downstream features will use.
- Keep plugin registration static at build time for now. Runtime loading of arbitrary npm plugins is intentionally out of scope because it creates bundling, trust, and server/client execution risks.
- Keep the first implementation small enough to land safely while establishing durable boundaries.

## Non-Goals

- Do not replace Tiptap with BlockNote, Lexical, Slate, Milkdown, or Editor.js.
- Do not implement a remote plugin marketplace.
- Do not execute untrusted plugin code.
- Do not migrate document storage or proposal schemas as part of this work.
- Do not fully extract every current editor feature in the first pass. Start with a practical built-in plugin split and leave clear migration seams.

## Proposed Architecture

Create `src/plugins/` as the public extension layer for editor capabilities.

Core files:

- `src/plugins/types.ts`: public plugin types and contribution interfaces.
- `src/plugins/registry.ts`: validates plugin ids, dependency order, disabled plugins, and contribution flattening.
- `src/plugins/builtin/index.ts`: exports the default plugin list used by the app.
- `src/plugins/builtin/core-document-plugin.ts`: wraps Tiptap schema and behavior extensions such as StarterKit, Link, TableKit, TaskList, Typography, Markdown paste, and empty-list exit behavior.
- `src/plugins/builtin/ai-writing-plugin.ts`: contributes selection commands and command-bar AI presets.
- `src/plugins/builtin/slash-menu-plugin.ts`: contributes slash command items.
- `src/plugins/builtin/block-controls-plugin.ts`: contributes block control actions where practical.

The app should call a single registry creation function and pass resolved contributions into `DocumentEditor` and related components.

## Plugin Interface

The initial API should be intentionally typed and conservative:

```ts
export type EditorPlugin = {
  id: string;
  name: string;
  version: string;
  enabledByDefault?: boolean;
  dependencies?: string[];
  tiptapExtensions?: (context: EditorPluginContext) => Extension[];
  selectionCommands?: (context: EditorPluginContext) => EditorSelectionCommand[];
  slashCommands?: (context: EditorPluginContext) => EditorSlashCommand[];
  blockActions?: (context: EditorPluginContext) => EditorBlockAction[];
  toolbarItems?: (context: EditorPluginContext) => EditorToolbarItem[];
  workspacePanels?: (context: EditorPluginContext) => EditorWorkspacePanel[];
  settingsSections?: (context: EditorPluginContext) => EditorSettingsSection[];
};
```

`EditorPluginContext` should expose only stable app capabilities:

- current language
- localized editor messages
- feature flags and enabled plugin ids
- typed command helpers for common editor actions

It should not expose raw React state setters from `DocumentShell`.

## Data Flow

1. `defaultEditorPlugins` is created from built-in plugins plus any app-level additions.
2. `createEditorPluginRegistry()` validates and sorts plugins.
3. `DocumentShell` or a small `useEditorPlugins()` helper resolves the registry for the current language.
4. `DocumentEditor` receives resolved contributions:
   - `tiptapExtensions`
   - `selectionCommands`
   - `slashCommands`
   - `blockActions`
   - `toolbarItems`
5. Existing components render those contributions using the same UI patterns they use today.

## Error Handling

- Duplicate plugin ids should throw during registry creation.
- Missing dependencies should throw during registry creation.
- Cyclic dependencies should throw during registry creation.
- Disabled plugins should not contribute features.
- Contributions from disabled dependencies should not be loaded implicitly.
- UI event handlers from plugins should be wrapped by the caller where a failed action would otherwise break the editor interaction.

## Testing Strategy

Unit tests:

- registry accepts valid plugins
- duplicate ids fail
- missing dependencies fail
- dependency cycles fail
- disabled plugins are omitted
- dependency ordering is stable
- contributions flatten in deterministic order

Component tests:

- `DocumentEditor` receives plugin-provided Tiptap extensions.
- selection commands render from plugin contributions.
- slash menu renders plugin-provided entries.
- block action list can include plugin-provided actions without breaking existing actions.

E2E tests:

- existing AI selection, slash menu, block gutter, list drag, markdown paste, and responsive tests must remain passing.

## Documentation

Add `docs/PLUGINS.md` with:

- why the plugin layer exists
- how to create a plugin
- plugin lifecycle and contribution points
- example plugin that adds one selection command and one slash command
- security note explaining static registration
- compatibility note for downstream projects

Update `docs/ARCHITECTURE.md` to reference the plugin layer under Extension Points.

## Migration Plan

The first implementation should avoid a large rewrite:

1. Add registry and types.
2. Move Tiptap schema extensions into a `core-document-plugin` while keeping `createDocumentSchemaExtensions()` as a compatibility wrapper.
3. Convert selection and slash command definitions into plugin contributions.
4. Wire `DocumentEditor` to consume resolved contributions.
5. Add docs and tests.

Follow-up work can extract toolbar, block actions, workspace panels, settings sections, and provider-related plugins more deeply once the base API is stable.

## Acceptance Criteria

- A downstream developer can add a local plugin by appending it to a plugin list.
- The plugin can add at least one Tiptap extension, one slash menu item, and one AI selection command without editing `DocumentEditor`.
- Existing editor behavior is unchanged for built-in features.
- Registry failures are deterministic and covered by tests.
- Documentation explains the plugin API clearly enough for open-source reuse.
