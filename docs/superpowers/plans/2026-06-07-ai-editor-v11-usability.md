# AI Editor v1.1 Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Coredot Editor more immediately useful as a professional AI document editor by improving AI command discoverability, preserving review-oriented workflows, and defining the next high-impact product extensions.

**Architecture:** Keep AI mutations proposal-based and route all quick actions through the existing selection rewrite route. Use the static plugin layer and language pack for extensibility, and avoid provider/API changes unless a feature needs persistent new data.

**Tech Stack:** Next.js 16, React 19, Tiptap 3, Drizzle SQLite/libSQL, Vercel AI SDK, Core.Today LLM proxy, Vitest, Testing Library, Playwright.

---

## Priority Review

### P0: AI Command Discoverability

Users should not need to know what to type into the bottom AI command bar. Add scope-aware quick action chips that submit stable command strings through the existing command path.

### P1: Explainable Rewrite Proposals

Rewrite, translation, continue-writing, and command-bar proposals should carry a short explanation when the model can provide one. Keep plain text provider outputs backward compatible.

### P2: Persistent AI Work Context

Show richer active and completed AI work metadata: command, scope, source snippet, model/provider, elapsed time, and status. This should live in the right AI workspace and run history.

### P3: Inline Autocomplete

Add a lightweight, opt-in inline continuation suggestion at the caret. Keep it separate from review proposals so users can accept with keyboard affordances without polluting the proposal queue.

### P4: Retrieval And Citation

Introduce document library ingestion, source selection, and citation verification. AI output should be able to reference uploaded documents, page/section metadata, and verified source snippets.

### P5: Product-Grade Operations

Add auth, workspace ownership, Postgres migration support, audit logs, and provider policy controls before handling sensitive production documents.

## Implementation Slice For This Pass

### Task 1: Add Scope-Aware AI Command Presets

**Files:**

- Modify: `src/components/document/DocumentAiCommandBar.tsx`
- Modify: `src/components/document/DocumentAiCommandBar.test.tsx`
- Modify: `src/features/i18n/editor-language.ts`
- Optionally verify: `src/components/document/DocumentEditor.test.tsx`

**Behavior:**

- Show quick action chips above the input when the command bar has a valid target.
- Presets must be localized labels but submit stable English command strings.
- Presets should adapt to the selected scope:
  - `selection`: Improve clarity, Make concise, Translate to Korean, Translate to English
  - `currentBlock`: Improve clarity, Strengthen evidence, Continue writing
  - `document`: Summarize document, Create outline, Review key risks
- Preset clicks should use the same `onSubmit(command)` path as typed commands.
- Presets should be disabled when the command bar is disabled or at capacity.
- Layout must stay compact on mobile and must not cover the editor text more than the existing command bar already does.

**Tests:**

- Render Korean preset labels for the active scope.
- Click a preset and assert the stable command string passed to `onSubmit`.
- Do not render preset chips when there is no valid target.
- Keep existing disabled placeholder behavior.

### Task 2: Document The Larger v1.2+ Roadmap

**Files:**

- Modify: `README.md`
- Modify or create: `docs/ROADMAP.md`

**Behavior:**

- Document the recommended build order after v1.1:
  1. AI work context and run metadata
  2. Inline autocomplete
  3. Retrieval and citation
  4. Collaboration and audit
  5. Plugin packs
- Keep README concise and link to the dedicated roadmap.

### Task 3: Preserve Explanations From Structured Rewrite Output

**Files:**

- Modify: `src/app/api/ai/rewrite/route.ts`
- Modify: `src/app/api/ai/rewrite/route.test.ts`
- Modify: `docs/PROMPTING.md`

**Behavior:**

- Ask providers for `{ replacementText, explanation }` in selection rewrite mode.
- Accept plain text output as a backward-compatible fallback.
- Accept fenced or unfenced structured JSON.
- If a provider accidentally returns review-style `findings[]`, extract the first `replacementText` and use its `reason` or `problem` as the explanation.
- Persist the explanation into `ai_proposals.explanation`.

### Task 4: Verify Release Quality

**Commands:**

```bash
pnpm vitest run src/components/document/DocumentAiCommandBar.test.tsx
pnpm test
pnpm release:check
git diff --check
```

**Expected Result:**

- All focused tests pass.
- Full test suite and release gate pass.
- No whitespace or secret-scan issues.
