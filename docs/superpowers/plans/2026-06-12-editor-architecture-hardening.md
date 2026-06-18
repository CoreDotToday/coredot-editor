# Editor Architecture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the editor's extensibility by tightening AI command boundaries, provider payload limits, selection command metadata, and command registry typing.

**Architecture:** Keep the UI intact and add small vertical seams where future AI/RAG/plugin work will attach. Server route handlers should delegate shared preflight work to feature services; provider payload construction should apply explicit size policy; plugin commands should carry behavior metadata instead of relying on localized command text.

**Tech Stack:** Next.js App Router, React, Tiptap, Zod, Vitest, TypeScript.

---

### Task 1: AI Command Request Preflight

**Files:**
- Create: `src/features/ai/ai-command-service.ts`
- Test: `src/features/ai/ai-command-service.test.ts`
- Modify: `src/app/api/ai/rewrite/route.ts`
- Modify: `src/app/api/ai/review/route.ts`

- [x] **Step 1: Write failing tests**
  - Added tests for document/template/provider/reference preparation, unsaved draft text selection, variable validation failure, and provider configuration failure.

- [x] **Step 2: Implement shared preflight service**
  - Added `prepareAiCommandRequest()` with dependency injection for route-independent tests.
  - Moved document lookup, template lookup, variable validation, reference hydration, settings lookup, and provider creation into the service.

- [x] **Step 3: Wire routes**
  - Updated review/rewrite routes to call the service and keep route-specific proposal/result logic local.

### Task 2: AI Payload Limits

**Files:**
- Create: `src/features/ai/context-limits.ts`
- Modify: `src/features/ai/types.ts`
- Test: `src/features/ai/types.test.ts`
- Modify: `src/features/ai/payload-builder.ts`
- Test: `src/features/ai/payload-builder.test.ts`

- [x] **Step 1: Write failing tests**
  - Added tests for oversized command rejection, reference-count rejection, explicit default apply mode parsing, and provider message truncation.

- [x] **Step 2: Implement schema and provider-message limits**
  - Added explicit command/context/document/reference limits.
  - Truncated document and reference bodies before provider calls with visible `[truncated ... characters]` markers.

### Task 3: Selection Command Metadata

**Files:**
- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/builtin/ai-writing-plugin.ts`
- Modify: `src/components/document/SelectionAiMenu.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Test: `src/components/document/DocumentShell.test.tsx`
- Test: `src/components/document/DocumentEditor.test.tsx`

- [x] **Step 1: Write failing tests**
  - Updated menu tests to require command metadata including command id and default apply mode.

- [x] **Step 2: Implement metadata flow**
  - Added `defaultApplyMode` to selection command contributions.
  - Passed metadata from selection menu to editor shell and `/api/ai/rewrite`.
  - Preserved string fallback for direct API compatibility.

### Task 4: Command Registry Alignment

**Files:**
- Modify: `src/features/commands/document-command-manifest.ts`
- Modify: `src/components/document/commands/document-command-types.ts`
- Test: `src/components/document/commands/document-command-registry.test.ts`

- [x] **Step 1: Write failing tests**
  - Added a registry test that compares palette action ids with manifest-provided registry ids.

- [x] **Step 2: Implement typed alignment**
  - Added `getDocumentCommandRegistryIds()`.
  - Typed `DocumentCommandAction.id` as `DocumentCommandId`.
  - Moved command group typing into the manifest to avoid a type-only cycle.

### Subagent Review Inputs

- Copernicus reviewed architecture boundaries and highlighted `DocumentShell` concentration, AI route duplication, proposal atomicity, provider extensibility, and global AI settings.
- Maxwell reviewed AI/data boundaries and highlighted unbounded prompt payloads, reference boundary risks, provider branching, RAG provenance gaps, and route orchestration duplication.
- Parfit reviewed editor UI/plugin structure and highlighted plugin contribution drift, command manifest drift, schema/runtime extension divergence, and selection command string coupling.

### Completion Notes

- Implemented the small verticals that reduce immediate expansion risk without large UI rewrites.
- Final review found two Important issues: variables could bypass payload limits, and very large unsaved draft text could fail validation before provider truncation. Both were fixed with template variable schema enforcement, variable size limits, provider-side variable truncation, and a larger inbound document cap.
- Added `E2E_PORT` support so Playwright can run when the default `3100` port is already occupied by another local process.
- Added a provider capability registry with side-effect-free metadata lookup for streaming, reasoning effort, structured review, and Core.Today proxy support.
- Hardened AI reference hydration so server prompts use repository text/title, deduplicate IDs, and filter the active document before loading referenced documents.
- Added conditional proposal status updates with `expectedStatus` so accept/reject/undo requests do not silently overwrite proposal state changed by another tab or later request. Conflict responses now merge the server proposal back into the client queue, and bulk updates apply only server-confirmed successes to avoid stale full rollback after a partial conflict.
- Final verification passed:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (65 files, 406 tests)
  - `pnpm build`
  - `git diff --check`
  - `E2E_PORT=3200 pnpm e2e` (35 tests)
- Remaining larger follow-ups: split `DocumentShell` hooks, pass/persist selection `commandId` separately from prompt text, add source draft signatures to AI runs/proposals, add server-side proposal apply transactions, add workspace-scoped document/reference authorization, and persist AI workspace sessions server-side.
