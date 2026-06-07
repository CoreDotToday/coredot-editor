# Architecture

Coredot Editor is a Next.js application starter for AI-assisted business document editing. The architecture keeps editor UI, persistence, prompt templates, AI provider calls, and proposal workflows separated so downstream projects can replace one part without rewriting the whole app.

## High-Level Flow

```text
Browser
  |
  | document editing, template selection, review actions
  v
Next.js App Router pages and client components
  |
  | fetch / server actions
  v
Route handlers and repositories
  |
  | Drizzle ORM
  v
SQLite/libSQL database

AI routes
  |
  | provider contract
  v
Stub provider or model provider
```

## Main Boundaries

### App Routes

`src/app/` contains pages and API routes.

- `src/app/documents/page.tsx` lists documents and creates drafts.
- `src/app/documents/[id]/page.tsx` loads one document, templates, AI runs, and proposals.
- `src/app/templates/page.tsx` loads the template manager.
- `src/app/api/*` contains JSON route handlers for documents, templates, AI commands, and proposals.

Route handlers should validate input with Zod, return predictable status codes, and delegate database logic to repositories.

### Editor UI

`src/components/document/` contains the three-pane workspace:

- Left: outline placeholder, prompt templates, template variables, and AI run history
- Center: Tiptap document editor, selection menu, and bottom AI command bar
- Right: AI workspace with review, conversation, and change-history tabs

`DocumentShell` owns transient client state such as the current draft, selected template, template variables, review status, editor language, chat entries, reversible local change records, and proposal status updates.

The bottom command bar is intentionally an entry point, not a mutation surface. It resolves the target in this order: selected text, current text block, then whole document. The command then uses the existing selection rewrite route so all AI edits still become proposals with redline previews.

Selection AI progress is tied to the captured command context, not the browser's live selection state. When a user runs a command, the editor stores the selected text, Tiptap range, occurrence index, and floating anchor from that moment. The inline progress badge and right workspace status continue to show the active job even if the user clicks elsewhere or selects another block. This matches legal drafting expectations: the source is fixed, the user can keep reviewing, and the result returns as an accept/reject proposal rather than an automatic mutation.

### Editor Plugin Layer

`src/plugins/` contains the static editor plugin layer. Built-in document behavior is declared as plugins, and downstream projects can register app-specific plugins in `src/plugins/app-plugins.ts`.

The currently rendered contribution types are:

- Tiptap extensions
- Selection AI commands
- Slash menu commands

`DocumentEditor` resolves these contributions through `useEditorPlugins()`. The compatibility function `createDocumentSchemaExtensions()` is intentionally narrower: it calls only the server-safe core document plugin so DOCX import/export routes do not load React UI plugins or browser-only code.

See [PLUGINS.md](PLUGINS.md) for the plugin authoring guide and test checklist.

### Editor Language Pack

`src/features/i18n/editor-language.ts` contains the lightweight editor language pack. Korean is the default locale, and the current editor language is stored in `localStorage` under `coredot-editor-language`.

Add new editor UI languages by extending `EditorLanguage`, `editorLanguageOptions`, and `editorMessages`. AI command payloads intentionally stay stable English strings so provider prompts and existing route contracts do not change when the UI language changes.

### Template System

`src/features/templates/` contains:

- `template-repository.ts`: database access for prompt templates
- `template-validation.ts`: variable schema and user variable validation

Templates store:

- `systemPrompt`
- `category`
- `variableSchemaJson`
- active/default flags

The variable schema drives both UI input rendering and server-side validation.

Prompt templates are also part of the proposal contract. Review prompts must produce exact document substrings as `targetText` and direct replacement text as `replacementText`. Rewrite and translation prompts must return only the replacement text. See [PROMPTING.md](PROMPTING.md) for the template checklist.

### AI Provider Layer

`src/features/ai/providers.ts` defines the provider contract:

- `generateText`
- `streamText`
- `generateReview`

The saved runtime setting in `app_settings` selects `stub`, `coredot`, `anthropic`, `gemini`, or `openai`. The initial row is seeded from environment variables, but the editor header's `LLM 설정` dialog controls non-secret provider/model settings afterward. API keys remain server-side environment variables and are never persisted in browser storage.

The `coredot`, `anthropic`, and `gemini` provider modes route calls through Core.Today's LLM proxy with provider-specific request formats. The `openai` provider uses the Vercel AI SDK and `@ai-sdk/openai` directly. `stub` keeps local development and tests deterministic.

Add new providers behind the same contract. Keep provider-specific configuration out of UI components.

### AI Runs And Proposals

AI operations create records in two tables:

- `ai_runs`: one record per AI command
- `ai_proposals`: suggested edits generated by review or rewrite flows

Routes finalize runs and proposals together through repository functions where consistency matters. Failed AI operations should mark a run as failed when a run already exists and should avoid leaving contradictory proposal state.

The review panel renders pending proposals as an attorney-assist review queue. Each item shows the issue explanation, the exact source text, the proposed replacement, and a redline-style preview that labels inserted and deleted text. Users can accept a replacement, insert the proposal below the source text, reject it, bulk accept/reject pending proposals, or focus the matching source text in the editor.

The right AI workspace separates three user jobs:

- `Review`: proposal queue and document review execution.
- `Chat`: a running conversation log for selection and command-bar requests.
- `Changes`: accepted AI applications that can be locally undone while the draft still matches the post-apply snapshot.

Undo is conservative. The client stores the draft snapshot immediately before a proposal is accepted and the content signature immediately after applying it. If the user edits the document later, the undo button is disabled for that item rather than overwriting newer work.

### Proposal Applicability

`src/features/proposals/proposal-apply.ts` contains exact-match text replacement logic. Proposal targets must match the reviewed document text exactly once before they are persisted.

Selection proposals also store `occurrenceIndex`, `targetFrom`, and `targetTo` metadata when the client can capture the active editor range. The editor uses this metadata to highlight pending suggestions in the document and to keep repeated-text selection edits scoped to the captured occurrence.

This is intentionally conservative. Downstream products that need full Microsoft Word-style tracked changes can evolve the proposal model from exact text plus range metadata into position-based or step-map-based proposal application, or into an Office.js add-in that writes native Word revisions.

## Database Model

The schema lives in `src/db/schema.ts`.

Core tables:

- `documents`
- `prompt_templates`
- `ai_runs`
- `ai_proposals`
- `app_settings`

The app currently uses SQLite/libSQL through `@libsql/client`. Drizzle keeps the persistence layer explicit enough to migrate later.

## SQLite Today, Postgres Later

The current implementation is SQLite-first. To migrate to Postgres:

1. Replace SQLite table builders in `src/db/schema.ts` with Drizzle Postgres table builders.
2. Replace `src/db/client.ts` with a Postgres client.
3. Update `drizzle.config.ts` dialect and credentials.
4. Regenerate migrations.
5. Re-run repository tests against a Postgres test database.

Keep repository function signatures stable while doing this so UI and route code do not need broad changes.

## Test Strategy

- Repository tests use isolated temporary databases.
- Route tests mock repositories and providers where appropriate.
- Component tests use Testing Library.
- E2E tests use Playwright and an isolated database at `data/e2e/coredot-e2e.db`.

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
```

## Extension Points

Common downstream changes:

- Add authentication and user/workspace ownership.
- Replace SQLite with Postgres or hosted libSQL.
- Add a new AI provider.
- Replace seeded prompt templates.
- Extend contract review playbooks with clause libraries, organization precedents, and benchmark rules.
- Add richer proposal application with editor ranges.
- Add app-specific editor plugins through `src/plugins/app-plugins.ts`.
- Add collaboration with Yjs or another sync layer.
- Extend the DOCX MVP toward comments, tracked changes, embedded media, and stricter Word layout fidelity.

Keep these additions behind clear route, repository, or provider boundaries.
