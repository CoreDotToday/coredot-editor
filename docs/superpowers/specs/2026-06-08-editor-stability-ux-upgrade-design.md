# Editor Stability And Block UX Upgrade Design

## Context

Coredot Editor already uses Tiptap as the document engine and has a substantial editor surface: selection AI, command bar AI, right-side review workspace, proposal redlines, slash commands, block gutter controls, nested-list movement, plugin contributions, and Korean-first localization.

The current implementation is functional, but the most fragile area is block-level interaction. `DocumentEditor` coordinates editor state, block gutter positioning, drag state, drop target discovery, proposal application, and AI command targeting in one large component. The pure JSON movement helpers in `tiptap-blocks.ts` are valuable, but the UI-side session handling and target calculation still need clearer boundaries.

Tolaria is a useful reference because it keeps a strong separation between editor surface, save/sync logic, raw/rich modes, block resolution, and side-menu drag state. It should not be copied wholesale because Tolaria is BlockNote and Markdown/filesystem-first, while Coredot Editor is Tiptap, proposal/redline, and database-oriented. The right move is to borrow stability patterns without changing the editor engine.

## Chosen Approach

Use the stability-first upgrade path:

- Keep Tiptap as the editor engine.
- Keep the existing JSON movement helpers and tests as the behavioral baseline.
- Extract block interaction responsibilities out of `DocumentEditor` into focused modules.
- Add session guards and UI affordances inspired by Tolaria.
- Improve proposal and AI command targeting by preserving operation snapshots.
- Document the architecture for open-source maintainers and plugin authors.

This is preferred over a large Markdown/raw-mode import from Tolaria because the latter would expand scope and risk near v1. It is also preferred over UI-only polish because the recurring user issues are mostly caused by interaction state and block movement boundaries, not only styling.

## Goals

- Make block gutter positioning more predictable across paragraphs, headings, bullet lists, ordered lists, nested lists, and narrow layouts.
- Make drag-and-drop behavior easier to reason about and easier to test.
- Prevent stale drag or AI proposal operations from applying to the wrong document range.
- Preserve current editor behavior unless a change directly improves the known UX issues.
- Keep the plugin architecture compatible with future editor features.
- Improve documentation enough for external contributors to understand where to extend the editor.

## Non-Goals

- Do not replace Tiptap with BlockNote, Lexical, Slate, or another editor engine.
- Do not migrate document storage.
- Do not implement a full Markdown/raw editing mode in this pass.
- Do not add runtime third-party plugin loading.
- Do not redesign the full app layout or AI workspace.
- Do not change provider APIs unless required for operation snapshots.

## Architecture

### Block Interaction Modules

Create focused modules under `src/components/document/` or `src/features/documents/`:

- `editor-block-ranges.ts`: resolve a DOM/editor position into a normalized block range.
- `editor-block-drop-targets.ts`: compute valid drop targets for top-level blocks, list items, and nested list items.
- `editor-block-drag-session.ts`: hold source snapshot, source range, drag status, document signature, and stale-session checks.
- `editor-block-actions.ts`: contain high-level block actions that currently live in `DocumentEditor`, while delegating document transforms to `tiptap-blocks.ts`.

`DocumentEditor` should remain the composition point, but it should no longer need to understand every low-level block range and drag edge case inline.

### Existing Movement Helpers

Keep `src/features/documents/tiptap-blocks.ts` as the low-level document transform layer. It already owns pure JSON transforms for:

- moving top-level blocks
- moving list items within and across parents
- moving top-level blocks into list context
- moving list items out to top-level context
- converting list items to paragraphs

The upgrade should add tests around newly extracted target/session modules instead of weakening existing movement tests.

### Drag Session Guard

Each drag session should capture:

- source block range
- source block type
- source text preview
- source document signature
- starting editor selection
- whether the source came from a list item or top-level block

Before applying a drop, the session must verify that the current document signature still matches the captured signature. If it does not match, cancel the drop and hide the indicator instead of attempting a best-effort mutation.

### Drop Target Rules

Drop target calculation should explicitly return one of these states:

- no target
- top-level before
- top-level after
- list item before
- list item after
- list item child
- invalid descendant target
- same-slot no-op

Invalid and no-op targets should not render a misleading indicator and should not mutate the document.

### Block Gutter Positioning

The gutter should anchor to the active block's visual line without covering the caret or primary content. It should:

- use the block's visible text/content box when available
- account for list marker indentation
- account for nested list depth
- clamp within the editor scroll frame
- hide during non-empty text selection
- stay available on empty list items and nested list items
- avoid overlapping selection AI menus

On narrow layouts, the gutter can move closer to the editor margin or collapse to a smaller affordance, but it should not cover the caret.

### Drag Preview And Indicator

Add a lightweight drag preview rather than cloning editor DOM. The preview should show:

- block type label when useful
- short text snippet
- subdued styling

The drop indicator should stay visually stable and should not animate large document shifts. The document should only mutate on pointer release.

### AI Operation Snapshots

AI commands and proposals should preserve the target at command start:

- selection range or current block range
- source text
- command string
- command scope
- document signature

Accept, replace, append, reject, and view actions should use the stored snapshot where possible. If the document changed in a way that invalidates the snapshot, the UI should explain that the proposal is stale and offer rerun, not silently fail.

## Data Flow

1. Pointer movement or editor selection changes ask the range module for the current block range.
2. `DocumentEditor` stores only the normalized gutter state.
3. Drag start creates a drag session from the current block range and document signature.
4. Drag movement asks the drop target module for a valid target.
5. Pointer release validates the session, applies a transform from `tiptap-blocks.ts`, restores scroll, and focuses the moved block.
6. AI command start creates an operation snapshot.
7. Proposal actions apply against the snapshot or show a stale-operation message.

## Error Handling

- Cancel stale drag sessions without mutation.
- Suppress indicators for invalid descendant targets and same-slot no-ops.
- Preserve the existing document if a JSON transform returns `null`.
- Keep the editor focused only after successful mutations.
- Show actionable Korean UI messages for stale AI proposals.
- Log unexpected transform failures in development without exposing noisy stack traces to users.

## Testing Strategy

Unit tests:

- block range resolution for paragraphs, headings, bullets, ordered lists, nested lists, and empty list items
- drop target classification for valid, invalid, descendant, and same-slot cases
- drag session stale-document cancellation
- AI operation snapshot validity and stale-state messaging

Component tests:

- gutter stays aligned for nested list items
- gutter does not cover caret in narrow layouts
- drag preview appears while dragging and disappears after cancel/drop
- add-below works from nested list items
- block action menu can indent, outdent, convert, move, duplicate, and delete without breaking existing list structure

Regression tests:

- preserve the existing nested-list drag tests in `DocumentEditor.test.tsx`
- preserve selection AI, slash menu, command bar, proposal, and responsive layout tests

Release verification:

```bash
pnpm test
pnpm release:check
git diff --check
```

## Documentation

Update public docs after implementation:

- `README.md`: concise explanation of the editor, AI proposal workflow, and block interaction maturity.
- `docs/ARCHITECTURE.md`: editor module boundaries and data flow.
- `docs/PLUGINS.md`: where plugins can extend editor actions without touching block internals.
- Optional `docs/EDITOR_BLOCK_UX.md`: detailed block interaction model if the architecture doc becomes too dense.

## Acceptance Criteria

- `DocumentEditor` delegates block range, drop target, and drag session logic to focused modules.
- Existing editor tests still pass.
- Nested list block movement works in both upward and downward directions.
- List item, nested list item, and empty list item gutters appear in the expected place.
- The gutter does not cover the caret in normal paragraph and list editing.
- Invalid drag targets do not show misleading placement or mutate the document.
- Stale AI proposal actions show a clear Korean message and do not silently fail.
- README and architecture docs explain the upgraded editor structure.

