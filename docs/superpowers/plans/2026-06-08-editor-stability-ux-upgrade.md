# Editor Stability And Block UX Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize Coredot Editor block controls, nested-list drag behavior, and AI proposal targeting while keeping the existing Tiptap editor engine.

**Architecture:** Keep `DocumentEditor` as the composition component, but move block range, drop target, and drag session responsibilities into focused modules. Preserve the pure JSON transforms in `src/features/documents/tiptap-blocks.ts`, add stale-session guards, and document the resulting editor boundaries for open-source contributors.

**Tech Stack:** Next.js 16 App Router, React 19 client components, Tiptap 3, Vitest, Testing Library, TypeScript, Tailwind CSS.

---

## Preflight

- [ ] **Step 1: Confirm working tree state**

Run:

```bash
git status --short
```

Expected: no unrelated modified files. If unrelated user changes exist, leave them untouched and scope all edits to files named in this plan.

- [ ] **Step 2: Read local Next guidance before code edits**

Run:

```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/index.md
sed -n '1,220p' node_modules/next/dist/docs/03-architecture/accessibility.md
```

Expected: confirm this work remains inside client components and keeps accessible labels for editor controls.

## File Structure

Create or modify these files:

- Create: `src/components/document/editor-block-ranges.ts`
  - Owns block action range types, pointer-to-range hit testing, list DOM path helpers used by gutter positioning, and `readBlockGutterPosition`.
- Create: `src/components/document/editor-block-drop-targets.ts`
  - Owns `BlockDropTarget`, `BlockDropIndicator`, target classification, no-op suppression, and indicator calculation.
- Create: `src/components/document/editor-block-drag-session.ts`
  - Owns captured drag session metadata and stale-document checks.
- Modify: `src/components/document/DocumentEditor.tsx`
  - Imports extracted helpers, renders drag preview, validates drag sessions before mutation, and keeps composition-level state.
- Modify: `src/components/document/BlockGutterControls.tsx`
  - Emits enough drag lifecycle state for stable preview rendering and hides menu cleanly during pointer drag.
- Modify: `src/components/document/DocumentEditor.test.tsx`
  - Updates imports and adds focused regressions for extracted modules and drag preview.
- Modify: `src/components/document/DocumentShell.tsx`
  - Persists AI operation snapshots more explicitly and shows clearer stale proposal feedback.
- Modify: `src/features/proposals/proposal-transaction.ts`
  - Adds a typed snapshot alias for proposal application context without changing the storage schema.
- Modify: `src/features/i18n/editor-language.ts`
  - Adds or reuses Korean messages for stale AI proposal actions.
- Modify: `README.md`
  - Notes the stable editor structure and AI proposal workflow.
- Modify: `docs/ARCHITECTURE.md`
  - Documents editor module boundaries.
- Modify: `docs/PLUGINS.md`
  - Clarifies plugin extension points versus internal block movement modules.

## Task 1: Extract Block Range And Gutter Positioning

**Files:**

- Create: `src/components/document/editor-block-ranges.ts`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/DocumentEditor.test.tsx`

- [ ] **Step 1: Write the failing import test**

In `src/components/document/DocumentEditor.test.tsx`, change the imports so range helpers come from the new module:

```ts
import {
  getBlockActionRangeAtPosition,
  readBlockGutterPosition,
} from "./editor-block-ranges";
import { DocumentEditor, getSelectionMenuPosition } from "./DocumentEditor";
```

Keep the existing tests named:

- `keeps the full nested list item path for caret-based block controls`
- `anchors nested list gutter controls from the path target instead of a stale nodeDOM result`
- `keeps shallow block gutter controls attached to the active line when left gutter space is tight`
- `places block gutter controls on the right when a narrow layout has no safe left margin`

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx
```

Expected: fail because `./editor-block-ranges` does not exist.

- [ ] **Step 3: Create the range module**

Create `src/components/document/editor-block-ranges.ts` with these exports:

```ts
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

export type RuntimeEditor = Editor;

export type TopLevelBlockRange = {
  from: number;
  index: number;
  node: ProseMirrorNode;
  to: number;
};

export type BlockActionRange = {
  from: number;
  kind: "listItem" | "topLevel";
  listItemIndex?: number;
  listItemPath?: number[];
  node: ProseMirrorNode;
  to: number;
  topLevelIndex: number;
};

export const BLOCK_GUTTER_WIDTH = 58;
export const BLOCK_GUTTER_EDGE_GAP = 8;
export const BLOCK_GUTTER_HORIZONTAL_OFFSET = 68;
export const BLOCK_GUTTER_MIN_TEXT_GAP = 4;
export const LIST_BLOCK_GUTTER_TEXT_GAP = 16;
```

Move the existing implementations from `DocumentEditor.tsx` into this file without behavioral changes:

- `getBlockActionRangeAtPosition`
- `getBlockActionRangeFromDomTarget`
- `getBlockActionRangeAtViewportY`
- `readBlockGutterPosition`
- `readTopLevelBlockRangeAtPosition`
- `getListItemActionRangeAtPosition`
- `getTopLevelBlockActionRangeByIndex`
- `getListItemOwnIndex`
- `getListItemParentPath`
- `readListItemDomByPath`
- `readListItemContentElement`
- `getListItemDomPath`
- `samePath`
- `startsWithPath`
- `clamp`
- all small private helpers only used by those functions

Export these functions for downstream modules:

```ts
export {
  clamp,
  getListItemOwnIndex,
  getListItemParentPath,
  getTopLevelBlockActionRangeByIndex,
  readListItemContentElement,
  samePath,
  startsWithPath,
};
```

- [ ] **Step 4: Replace local definitions in `DocumentEditor.tsx`**

Remove the moved type and function definitions from `DocumentEditor.tsx`. Add:

```ts
import {
  BLOCK_GUTTER_WIDTH,
  getBlockActionRangeAtPosition,
  getListItemOwnIndex,
  getListItemParentPath,
  getTopLevelBlockActionRangeByIndex,
  readBlockGutterPosition,
  samePath,
  startsWithPath,
  type BlockActionRange,
} from "./editor-block-ranges";
```

Keep `getSelectionMenuPosition`, `toSelectionRect`, `getFallbackSelectionMenuPosition`, `readCommandBarResultAnchor`, `mergeEditorPluginContributions`, and `escapeCssAttributeValue` in `DocumentEditor.tsx`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx
```

Expected: all `DocumentEditor` tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/components/document/DocumentEditor.tsx src/components/document/DocumentEditor.test.tsx src/components/document/editor-block-ranges.ts
git commit -m "refactor: extract editor block ranges"
```

## Task 2: Extract Drop Target Classification

**Files:**

- Create: `src/components/document/editor-block-drop-targets.ts`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/DocumentEditor.test.tsx`

- [ ] **Step 1: Write the import boundary test**

In `src/components/document/DocumentEditor.test.tsx`, add an import:

```ts
import { isNoopBlockDropTarget } from "./editor-block-drop-targets";
```

Add this test near the nested-list drag tests:

```ts
it("classifies same-slot list drops as no-op targets", () => {
  const source = {
    from: 1,
    kind: "listItem" as const,
    listItemIndex: 1,
    listItemPath: [1],
    node: {} as never,
    to: 2,
    topLevelIndex: 0,
  };

  expect(
    isNoopBlockDropTarget(source, {
      dropIndex: 1,
      indicator: { left: 0, top: 0, width: 100 },
      kind: "listItem",
      listItemPath: [],
      topLevelIndex: 0,
    }),
  ).toBe(true);

  expect(
    isNoopBlockDropTarget(source, {
      dropIndex: 3,
      indicator: { left: 0, top: 0, width: 100 },
      kind: "listItem",
      listItemPath: [],
      topLevelIndex: 0,
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx -t "same-slot list drops"
```

Expected: fail because `editor-block-drop-targets` does not exist.

- [ ] **Step 3: Create the drop target module**

Create `src/components/document/editor-block-drop-targets.ts` with these exported types:

```ts
import type { SelectionBlockDragPoint } from "./BlockGutterControls";
import {
  getListItemOwnIndex,
  getListItemParentPath,
  readListItemContentElement,
  samePath,
  startsWithPath,
  type BlockActionRange,
  type RuntimeEditor,
} from "./editor-block-ranges";

export type BlockDropIndicator = {
  left: number;
  top: number;
  width: number;
};

export type BlockDropTarget = {
  action?: "indent" | "outdent";
  dropIndex: number;
  indicator: BlockDropIndicator;
  kind: "betweenListItems" | "listItem" | "listLevel" | "topLevel";
  listItemPath?: number[];
  topLevelIndex?: number;
};
```

Move the existing drop-target implementations from `DocumentEditor.tsx` into this file:

- `getBlockDropTarget`
- `isNoopBlockDropTarget`
- `isPointInsideSourceList`
- `getListItemLevelDropTarget`
- `getListItemDropTarget`
- `getSourceParentListItemDropTarget`
- `getListItemDropTargetAtPoint`
- `getTopLevelBlockBetweenListItemsDropTargetAtPoint`
- `getListItemDropTargetForList`
- `createListItemDropTargetForParentList`
- `getDirectListItemElements`
- `getListDomElementByParentPath`
- `isPointInsideListDropBand`
- `isListItemDropInsideSourceDescendant`
- `getTopLevelBlockDropTarget`
- `getDropSlotByY`
- `readBlockDropRect`
- `getListItemElementAtViewportY`
- `getDirectListItemElementAtViewportY`
- `isListDomElement`
- `createListLevelDropIndicator`
- `createDropIndicator`

Keep these constants in the module:

```ts
const LIST_CONTENT_DROP_X_TOLERANCE = 8;
const LIST_LEVEL_DRAG_THRESHOLD = 48;
const LIST_LEVEL_VERTICAL_TOLERANCE = 28;
const LIST_SOURCE_PARENT_DROP_MARGIN = 16;
```

- [ ] **Step 4: Import drop helpers into `DocumentEditor.tsx`**

Remove the moved drop target types and functions from `DocumentEditor.tsx`. Add:

```ts
import {
  getBlockDropTarget,
  type BlockDropIndicator,
  type BlockDropTarget,
} from "./editor-block-drop-targets";
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx
```

Expected: all `DocumentEditor` tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/components/document/DocumentEditor.tsx src/components/document/DocumentEditor.test.tsx src/components/document/editor-block-drop-targets.ts
git commit -m "refactor: extract editor block drop targets"
```

## Task 3: Add Drag Session Guard And Preview

**Files:**

- Create: `src/components/document/editor-block-drag-session.ts`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/BlockGutterControls.tsx`
- Modify: `src/components/document/DocumentEditor.test.tsx`

- [ ] **Step 1: Add drag session unit tests through component behavior**

In `src/components/document/DocumentEditor.test.tsx`, add:

```ts
it("shows a lightweight block drag preview while dragging", async () => {
  render(
    <DocumentEditor
      contentJson={createFlatListDocument(["1", "2", "3"])}
      onChange={() => undefined}
      title="Drag preview test"
    />,
  );

  const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
  const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
  Object.defineProperty(frame, "clientWidth", { value: 900 });
  Object.defineProperty(frame, "scrollTop", { value: 0 });
  mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
  mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });
  mockRenderedFlatListMetrics(editorBody);

  fireEvent.mouseMove(screen.getByText("2"), { clientX: 200, clientY: 176 });
  const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
  dragHandle.setPointerCapture = vi.fn();
  dragHandle.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(dragHandle, { button: 0, clientX: 120, clientY: 176, pointerId: 1 });
  fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 140, clientY: 220, pointerId: 1 });

  expect(screen.getByRole("status", { name: "블록 이동 미리보기" })).toHaveTextContent("2");

  fireEvent.pointerUp(dragHandle, { clientX: 140, clientY: 220, pointerId: 1 });

  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "블록 이동 미리보기" })).not.toBeInTheDocument();
  });
});
```

Add a stale-session test:

```ts
it("cancels a block drop when the document changed during dragging", async () => {
  const handleChange = vi.fn();
  const { rerender } = render(
    <DocumentEditor
      contentJson={createFlatListDocument(["1", "2", "3"])}
      onChange={handleChange}
      title="Stale drag test"
    />,
  );

  const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
  const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
  Object.defineProperty(frame, "clientWidth", { value: 900 });
  Object.defineProperty(frame, "scrollTop", { value: 0 });
  mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
  mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });
  mockRenderedFlatListMetrics(editorBody);

  fireEvent.mouseMove(screen.getByText("2"), { clientX: 200, clientY: 176 });
  const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
  dragHandle.setPointerCapture = vi.fn();
  dragHandle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(dragHandle, { button: 0, clientX: 120, clientY: 176, pointerId: 1 });
  fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 120, clientY: 240, pointerId: 1 });

  rerender(
    <DocumentEditor
      contentJson={createFlatListDocument(["1", "changed", "3"])}
      onChange={handleChange}
      title="Stale drag test"
    />,
  );

  fireEvent.pointerUp(dragHandle, { clientX: 120, clientY: 240, pointerId: 1 });

  expect(handleChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx -t "block drag preview|document changed during dragging"
```

Expected: fail because no drag preview exists and stale session is not captured.

- [ ] **Step 3: Create drag session module**

Create `src/components/document/editor-block-drag-session.ts`:

```ts
import type { TiptapJson } from "@/db/schema";
import type { BlockActionRange } from "./editor-block-ranges";

export type EditorBlockDragSession = {
  documentSignature: string;
  source: BlockActionRange;
  sourceText: string;
  sourceType: "listItem" | "topLevel";
};

export function createEditorBlockDragSession(contentJson: TiptapJson, source: BlockActionRange): EditorBlockDragSession {
  return {
    documentSignature: getEditorBlockDocumentSignature(contentJson),
    source,
    sourceText: source.node.textContent.trim().slice(0, 80),
    sourceType: source.kind,
  };
}

export function isEditorBlockDragSessionStale(session: EditorBlockDragSession, contentJson: TiptapJson) {
  return session.documentSignature !== getEditorBlockDocumentSignature(contentJson);
}

export function getEditorBlockDocumentSignature(contentJson: TiptapJson) {
  return JSON.stringify(contentJson);
}
```

- [ ] **Step 4: Wire session guard into `DocumentEditor.tsx`**

Replace `draggingBlockRef` with:

```ts
const blockDragSessionRef = useRef<EditorBlockDragSession | null>(null);
const [blockDragPreview, setBlockDragPreview] = useState<{
  left: number;
  text: string;
  top: number;
  type: "listItem" | "topLevel";
} | null>(null);
```

On drag start, preserve the existing current-block fallback and capture the live editor JSON:

```ts
const source =
  blockGutterTargetRef.current ??
  blockGutter?.target ??
  getTopLevelBlockActionRangeByIndex(editor, selectionMenu?.blockIndex) ??
  getCurrentBlockActionRange(editor);
blockDragSessionRef.current = source ? createEditorBlockDragSession(editor.getJSON() as TiptapJson, source) : null;
blockDropTargetRef.current = null;
setBlockDropIndicator(null);
setBlockDragPreview(null);
```

On pointer drag move, read from `blockDragSessionRef.current?.source` and set:

```ts
setBlockDragPreview({
  left: point.clientX - frameRect.left + 12,
  text: blockDragSessionRef.current.sourceText || messages.selectionMenu.blockControls.draggingBlock,
  top: point.clientY - frameRect.top + editorFrameRef.current.scrollTop + 12,
  type: blockDragSessionRef.current.sourceType,
});
```

On pointer drag end, before applying a transform:

```ts
const session = blockDragSessionRef.current;
blockDragSessionRef.current = null;
setBlockDragPreview(null);
if (!session || isEditorBlockDragSessionStale(session, editor.getJSON() as TiptapJson)) {
  return;
}
const source = session.source;
```

Also update `handleBlockDragEnd`, pointer cancel, suppressed click, native drag over, and native drop paths so every drag exit clears `blockDragSessionRef`, `blockDropTargetRef`, `blockDropIndicator`, and `blockDragPreview`.

- [ ] **Step 5: Render preview**

Add below `BlockDropIndicator`:

```tsx
{blockDragPreview ? (
  <div
    aria-label={messages.selectionMenu.blockControls.dragPreviewLabel}
    className="pointer-events-none absolute z-40 max-w-56 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-xs text-zinc-600 shadow-lg shadow-zinc-950/10"
    role="status"
    style={{ left: blockDragPreview.left, top: blockDragPreview.top }}
  >
    <span className="font-medium text-zinc-900">
      {blockDragPreview.type === "listItem"
        ? messages.selectionMenu.blockControls.listItem
        : messages.selectionMenu.blockControls.block}
    </span>
    {blockDragPreview.text ? <span className="ml-1">{blockDragPreview.text}</span> : null}
  </div>
) : null}
```

- [ ] **Step 6: Add i18n labels**

In `src/features/i18n/editor-language.ts`, under `selectionMenu.blockControls`, add Korean and English keys:

```ts
block: "블록",
draggingBlock: "블록 이동 중",
dragPreviewLabel: "블록 이동 미리보기",
listItem: "리스트",
```

English:

```ts
block: "Block",
draggingBlock: "Moving block",
dragPreviewLabel: "Block drag preview",
listItem: "List item",
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx
```

Expected: all `DocumentEditor` tests pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/components/document/DocumentEditor.tsx src/components/document/DocumentEditor.test.tsx src/components/document/editor-block-drag-session.ts src/features/i18n/editor-language.ts
git commit -m "feat: guard editor block drag sessions"
```

## Task 4: Strengthen AI Proposal Operation Snapshots

**Files:**

- Modify: `src/features/proposals/proposal-transaction.ts`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/features/i18n/editor-language.ts`
- Test: existing proposal transaction and shell tests if present

- [ ] **Step 1: Add a typed operation snapshot**

In `src/features/proposals/proposal-transaction.ts`, replace `ProposalTransactionContext` with this compatible shape:

```ts
export type ProposalOperationSnapshot = {
  command?: string;
  contentSignature?: string;
  occurrenceIndex?: number;
  scope?: "selection" | "currentBlock" | "document";
  selectedText?: string;
  selectionRange?: ProposalSelectionRange;
};

export type ProposalTransactionContext = ProposalOperationSnapshot;

export function createProposalContentSignature(contentJson: TiptapJson) {
  return JSON.stringify(contentJson);
}

export function isProposalSnapshotStale(
  context: ProposalOperationSnapshot | undefined,
  contentJson: TiptapJson,
) {
  return Boolean(context?.contentSignature && context.contentSignature !== createProposalContentSignature(contentJson));
}
```

- [ ] **Step 2: Use snapshot signatures in `DocumentShell.tsx`**

Where selection proposals are stored after rewrite completion, include:

```ts
contentSignature: createProposalContentSignature(draft.contentJson),
command,
scope: context?.scope,
selectedText,
```

Import:

```ts
import {
  applyProposalToTiptapDraft,
  createProposalContentSignature,
  getProposalApplicationOrder,
  getProposalSelectionRange,
  isProposalSnapshotStale,
  type ProposalTransactionContext,
} from "@/features/proposals/proposal-transaction";
```

Before calling `applyProposalToTiptapDraft` in the single accept path:

```ts
if (isProposalSnapshotStale(proposalContext, draft.contentJson)) {
  setReviewError(messages.errors.staleSelection);
  return;
}
```

For bulk accept, preflight every snapshot-backed pending proposal against the original `draft.contentJson` before the loop mutates `nextContentJson`:

```ts
const staleSnapshotProposal = pendingProposals.find((proposal) =>
  isProposalSnapshotStale(selectionProposalContexts[proposal.id], draft.contentJson),
);
if (staleSnapshotProposal) {
  setReviewError(messages.errors.staleSelection);
  return;
}
```

- [ ] **Step 3: Preserve current behavior for review proposals**

Do not require `contentSignature` for review proposals that do not have a selection context. They should continue using occurrence and target text fallback logic.

- [ ] **Step 4: Run proposal tests**

Run:

```bash
pnpm vitest run src/features/proposals/proposal-transaction.test.ts src/components/document/DocumentShell.test.tsx
```

Expected: pass if both files exist. If `DocumentShell.test.tsx` does not exist, run:

```bash
pnpm vitest run src/features/proposals/proposal-transaction.test.ts src/components/document/DocumentEditor.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/features/proposals/proposal-transaction.ts src/components/document/DocumentShell.tsx src/features/i18n/editor-language.ts
git commit -m "feat: snapshot ai proposal targets"
```

## Task 5: Documentation Updates

**Files:**

- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PLUGINS.md`

- [ ] **Step 1: Update README**

Add a concise section named `Editor Architecture`:

```md
## Editor Architecture

Coredot Editor uses Tiptap as the document engine and keeps product behavior in focused layers:

- `DocumentEditor` composes the editor surface, toolbar, AI command bar, proposal highlights, and block controls.
- `editor-block-ranges.ts` resolves the current paragraph, heading, or list item into a normalized block target.
- `editor-block-drop-targets.ts` classifies drag destinations and suppresses invalid or no-op drops.
- `editor-block-drag-session.ts` guards drag operations against stale document state.
- `tiptap-blocks.ts` applies pure JSON transforms for top-level blocks and nested list items.
- The plugin registry contributes Tiptap extensions, slash commands, AI selection commands, and future editor actions.

AI changes are proposal-based by default. Selection commands preserve a target snapshot so stale edits can be detected before applying a replacement or insert-below action.
```

- [ ] **Step 2: Update architecture docs**

In `docs/ARCHITECTURE.md`, add a subsection under editor/client architecture:

```md
### Block Interaction Layer

Block controls are split into three responsibilities:

- Range resolution maps the current caret, pointer, or selection to a normalized top-level block or list item.
- Drop target calculation classifies the visual destination and rejects descendant or same-slot drops before a document mutation can happen.
- Drag sessions capture the source block and document signature so stale operations are canceled instead of applying to the wrong content.

Document mutations stay in pure Tiptap JSON helpers under `src/features/documents/tiptap-blocks.ts`.
```

- [ ] **Step 3: Update plugin docs**

In `docs/PLUGINS.md`, add:

```md
### Internal Block Movement Boundaries

Plugins can contribute commands and UI actions, but they should not directly mutate nested-list JSON. Use editor commands exposed by the host application, or add a typed host action first. This keeps block movement consistent with stale-session guards and drop-target validation.
```

- [ ] **Step 4: Commit docs**

Run:

```bash
git add README.md docs/ARCHITECTURE.md docs/PLUGINS.md
git commit -m "docs: explain editor block architecture"
```

## Task 6: Release Verification

**Files:**

- Verify only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run src/components/document/DocumentEditor.test.tsx src/features/proposals/proposal-transaction.test.ts
```

Expected: pass.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
pnpm test
```

Expected: pass.

- [ ] **Step 3: Run release check**

Run:

```bash
pnpm release:check
```

Expected: pass. If Playwright or audit fails because of a local environment issue, capture the exact failing command and error in the final report before deciding whether a code fix is required.

- [ ] **Step 4: Check formatting whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Final commit status**

Run:

```bash
git status --short
```

Expected: no uncommitted files after all task commits.
