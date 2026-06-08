# Tolaria-Inspired Editor Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Coredot Editor with Tolaria-inspired command, source, and AI workspace patterns while keeping the current Next.js/Tiptap proposal flow stable.

**Architecture:** Keep `DocumentShell` as the host coordinator, but move reusable behavior into focused modules. Command palette commands become typed registry entries, source inspection becomes a standalone component, and AI chat sessions gain a storage adapter that can later be replaced by database-backed repositories.

**Tech Stack:** Next.js 16, React 19, Tiptap 3, Vitest, Testing Library, localStorage-backed client adapters.

---

### Task 1: Command Registry And Palette Hardening

**Files:**
- Create: `src/components/document/commands/document-command-types.ts`
- Create: `src/components/document/commands/document-command-registry.ts`
- Create: `src/components/document/DocumentCommandPalette.tsx`
- Test: `src/components/document/DocumentCommandPalette.test.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [ ] Write tests for fuzzy search, disabled command hiding, keyboard navigation, grouped rendering, and shortcut display.
- [ ] Move command action definitions out of `DocumentShell` into a typed registry.
- [ ] Replace the inline palette with the standalone keyboard-accessible palette.
- [ ] Keep `Cmd/Ctrl+K`, review, save, export, and source/editor toggles behavior-compatible.

### Task 2: Source View V2

**Files:**
- Create: `src/components/document/DocumentSourceView.tsx`
- Test: `src/components/document/DocumentSourceView.test.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [ ] Write tests for current draft plain text, JSON validity status, copy buttons, and source download.
- [ ] Extract `DocumentSourceView` from `DocumentShell`.
- [ ] Add copy plain text, copy JSON, and download JSON affordances.
- [ ] Add a validation status that makes future editable source mode safer.

### Task 3: AI Workspace Session Adapter

**Files:**
- Create: `src/features/ai/ai-workspace-session-store.ts`
- Test: `src/features/ai/ai-workspace-session-store.test.ts`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/components/ai/AiWorkspacePanel.tsx`
- Modify: `src/features/i18n/editor-language.ts`

- [ ] Write tests for session snapshot serialization, invalid storage recovery, document-scoped separation, append/update/archive helpers, and reload status normalization.
- [ ] Persist chat session snapshots in a document-scoped localStorage adapter.
- [ ] Keep current in-memory UI behavior but restore sessions per document.
- [ ] Add a small archive control to the chat tab so stale sessions can be hidden without deleting active review data.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`

- [ ] Document the command registry, source inspection, and AI workspace session adapter.
- [ ] Run focused tests after each implementation task.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before completion.
