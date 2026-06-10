# Tolaria-Inspired Editor Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next practical Tolaria-inspired upgrades to Coredot Editor: a manifest-backed command layer, structured AI document references, and lightweight document metadata/filtering.

**Architecture:** Keep the implementation web/SaaS-native and MIT-clean by reimplementing patterns rather than copying Tolaria AGPL code. Add small feature modules under `src/features` and wire them into existing `DocumentShell`, `DocumentEditor`, `DocumentAiCommandBar`, and repository/API boundaries. Persist only stable document metadata in SQLite; keep AI reference selection client-side for this phase.

**Tech Stack:** Next.js App Router, React, Tiptap, Drizzle/libSQL SQLite, Vitest, Testing Library.

---

### Task 1: Manifest-Backed Document Commands

**Files:**
- Create: `src/features/commands/document-command-manifest.ts`
- Test: `src/features/commands/document-command-manifest.test.ts`
- Modify: `src/components/document/commands/document-command-registry.ts`
- Test: `src/components/document/DocumentShell.test.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`

- [x] **Step 1: Write failing tests**
  - Add tests that command ids are unique, shortcut resolution maps `Mod+K` to `open-command-palette`, `Mod+F` to `find-document`, and command registry derives shortcuts from the manifest.
  - Extend `DocumentShell.test.tsx` to verify `Meta+F` opens the find bar through the shell-level command layer.

- [x] **Step 2: Run tests to verify RED**
  - Run: `pnpm vitest run src/features/commands/document-command-manifest.test.ts src/components/document/DocumentShell.test.tsx src/components/document/DocumentCommandPalette.test.tsx`
  - Expected: new manifest tests fail because the module does not exist; shell shortcut test fails because `Mod+F` still lives inside `DocumentEditor`.

- [x] **Step 3: Implement manifest and registry wiring**
  - Add typed command ids, shortcut definitions, `resolveDocumentShortcut(event)`, and `getDocumentCommandShortcutLabel(id)`.
  - Update the document command registry to read shortcut labels from the manifest.
  - Move `Mod+F` handling from `DocumentEditor` to `DocumentShell`, beside `Mod+K`.

- [x] **Step 4: Verify GREEN**
  - Run the same focused command tests.

### Task 2: AI Document References

**Files:**
- Create: `src/features/ai/ai-reference-parser.ts`
- Test: `src/features/ai/ai-reference-parser.test.ts`
- Modify: `src/features/ai/ai-context-snapshot.ts`
- Test: `src/features/ai/ai-context-snapshot.test.ts`
- Modify: `src/features/ai/payload-builder.ts`
- Test: `src/features/ai/payload-builder.test.ts`
- Modify: `src/components/document/DocumentAiCommandBar.tsx`
- Test: `src/components/document/DocumentAiCommandBar.test.tsx`
- Modify: `src/components/document/DocumentEditor.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/app/documents/[id]/page.tsx`

- [x] **Step 1: Write failing parser/context tests**
  - Parser should resolve `@Document Title` and `@\"Document Title With Spaces\"` from available references, dedupe by id, and leave unmatched text alone.
  - Context snapshots should include `referencedDocuments` with title, id, char count, and truncated text.
  - Payload builder should include a `Referenced documents:` section.

- [x] **Step 2: Run tests to verify RED**
  - Run: `pnpm vitest run src/features/ai/ai-reference-parser.test.ts src/features/ai/ai-context-snapshot.test.ts src/features/ai/payload-builder.test.ts src/components/document/DocumentAiCommandBar.test.tsx`

- [x] **Step 3: Implement references**
  - Load draft documents in `DocumentPage` and pass a compact reference list to `DocumentShell`.
  - Pass reference choices to `DocumentEditor` and `DocumentAiCommandBar`.
  - Show attached references as small chips when the command contains valid `@` references.
  - Include resolved references in selection command payloads, AI context snapshots, and rewrite route payloads.

- [x] **Step 4: Verify GREEN**
  - Run focused AI reference tests and existing rewrite route tests.

### Task 3: Document Metadata and Filtering

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0005_document_metadata.sql`
- Modify: `src/features/documents/document-repository.ts`
- Test: `src/features/documents/document-repository.test.ts`
- Create: `src/features/documents/document-metadata.ts`
- Test: `src/features/documents/document-metadata.test.ts`
- Create: `src/components/document/DocumentMetadataPanel.tsx`
- Test: `src/components/document/DocumentMetadataPanel.test.tsx`
- Modify: `src/components/document/DocumentShell.tsx`
- Modify: `src/app/api/documents/[id]/route.ts`
- Modify: `src/features/i18n/editor-language.ts`

- [x] **Step 1: Write failing metadata tests**
  - Repository should create default metadata, update metadata without losing content, and preserve metadata during autosave.
  - Metadata filter should match document type, review status, risk level, and text query.
  - Panel should update fields and render Korean labels.

- [x] **Step 2: Run tests to verify RED**
  - Run: `pnpm vitest run src/features/documents/document-repository.test.ts src/features/documents/document-metadata.test.ts src/components/document/DocumentMetadataPanel.test.tsx src/components/document/DocumentShell.test.tsx`

- [x] **Step 3: Implement metadata persistence and panel**
  - Add `metadataJson` to documents with a migration default of `{}`.
  - Add normalize/update helpers and repository support.
  - Add a compact metadata panel in the left sidebar below the outline.
  - Include metadata in document save requests and AI context snapshots.

- [x] **Step 4: Verify GREEN**
  - Run focused metadata tests and document API tests.

### Task 4: Documentation and Final Review

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`

- [x] **Step 1: Update docs**
  - Document the command manifest, AI references, document metadata, and Tolaria licensing constraint.

- [x] **Step 2: Run full verification**
  - Run: `pnpm lint`
  - Run: `pnpm typecheck`
  - Run: `pnpm test`
  - Run: `pnpm build`
  - Run: `git diff --check`

- [x] **Step 3: Subagent final review**
  - Dispatch one read-only review subagent over the final working tree.
  - Fix Critical/Important findings and rerun focused checks.

### Completion Notes

- Implemented the command manifest, AI document references, document metadata/readiness filtering, and README/architecture documentation.
- Final review subagents reported migration, reference parsing, retry reference preservation, typing, duplicate-title selection, memo dependency, a11y, and metadata localization issues; those findings were fixed.
- Final verification passed on 2026-06-10:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (61 files, 388 tests)
  - `pnpm build`
  - fresh `pnpm db:migrate` against a temporary SQLite database
  - `git diff --check`
  - `pnpm e2e` (35 tests)
