# Tolaria Second-Wave Editor Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Upgrade Coredot Editor with Tolaria-inspired document navigation, find/replace, AI context transparency, and workspace session improvements while preserving the current Tiptap proposal flow.

**Architecture:** Keep `DocumentShell` as the state coordinator and add small, testable feature modules under `src/features/documents` and `src/features/ai`. UI additions should be focused components under `src/components/document` and `src/components/ai`, with i18n strings supplied through `editor-language.ts`.

**Tech Stack:** Next.js 16, React 19, Tiptap 3, Drizzle SQLite/Postgres-ready schema style, Vitest, Testing Library.

---

### Task 1: Document Outline Model And Panel

**Files:**
- Create: `src/features/documents/document-outline.ts`
- Create: `src/components/document/DocumentOutlinePanel.tsx`
- Test: `src/features/documents/document-outline.test.ts`
- Test: `src/components/document/DocumentOutlinePanel.test.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [x] Write failing tests for heading extraction from Tiptap JSON, nested H1/H2/H3 tree construction, duplicate-title handling, and empty outline fallback.
- [x] Implement `buildDocumentOutline(title, contentJson)` as a pure function that returns a root item and child heading items with stable ids.
- [x] Add `DocumentOutlinePanel` with click callbacks, active item affordance, and accessible empty state.
- [x] Replace the current placeholder outline copy in the left sidebar with the live outline panel.

### Task 2: In-Document Find Model And Compact UI

**Files:**
- Create: `src/features/documents/document-find.ts`
- Create: `src/components/document/DocumentFindBar.tsx`
- Test: `src/features/documents/document-find.test.ts`
- Test: `src/components/document/DocumentFindBar.test.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/components/document/commands/document-command-registry.ts`
- Modify: `src/features/i18n/editor-language.ts`

- [x] Write failing tests for plain text search, case-sensitive search, invalid regex handling, next/previous index wrapping, and replacement text generation.
- [x] Implement safe document find helpers without adding a new runtime dependency.
- [x] Add a compact find bar that supports query, count, next, previous, close, and optional replace fields.
- [x] Add `Cmd/Ctrl+F` and command palette entry to open the find bar.
- [x] Wire match navigation to the editor through a small callback surface; keep replacement model pure first if direct rich-editor replacement is unsafe.

### Task 3: AI Context Snapshot And Prompt Inspector

**Files:**
- Create: `src/features/ai/ai-context-snapshot.ts`
- Create: `src/components/ai/AiContextInspector.tsx`
- Test: `src/features/ai/ai-context-snapshot.test.ts`
- Test: `src/components/ai/AiContextInspector.test.tsx`
- Modify: `src/components/ai/AiWorkspacePanel.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [x] Write failing tests for active document snapshot, selected template metadata, template variables, selected text, proposal counts, truncation metadata, and prompt copy text.
- [x] Implement a structured snapshot builder with head/tail truncation and explicit truncation metadata.
- [x] Add an AI workspace inspector section that shows model-facing context and a copyable prompt/debug payload.
- [x] Include the context snapshot in selection rewrite and document review requests through `inputSummaryJson`-compatible metadata where practical.

### Task 4: AI Workspace Session Controls

**Files:**
- Modify: `src/features/ai/ai-workspace-session-store.ts`
- Modify: `src/components/ai/AiWorkspacePanel.tsx`
- Test: `src/features/ai/ai-workspace-session-store.test.ts`
- Test: `src/components/ai/AiWorkspacePanel.test.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [x] Write failing tests for rename, fork-after-message, regenerate marker, and archive/restore helper behavior.
- [x] Add pure helpers for rename and fork so localStorage can later be replaced by DB-backed sessions.
- [x] Add lightweight UI controls for rename/archive and expose action affordances on assistant messages.
- [x] Keep DB migration for full message persistence as a follow-up unless the UI and repositories are ready in this pass.

### Task 5: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`

- [x] Document the new outline, find, and context inspector behavior.
- [x] Document which Tolaria patterns were intentionally not copied.
- [x] Run focused tests after each task.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before completion.
