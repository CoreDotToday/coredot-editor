# Architecture

Coredot Editor is a Next.js application starter for AI-assisted business document editing. Its main seams keep identity, Workspace authorization, document changes, AI execution, Conversations, document interchange, and build-time plugins independently testable.

## High-Level Flow

```text
Clerk or deterministic test identity
  -> RequestContext (Principal, Workspace, role, request ID)
  -> Next.js pages and protected route handlers
  -> Workspace-scoped repositories and deep services
  -> Drizzle + SQLite/libSQL

Browser draft
  -> revision-aware document-change service
  -> atomic document + Proposal + Document Change transaction

AI route
  -> bounded preflight and execution lifecycle
  -> provider adapter
  -> AI Run + Proposal finalization
```

## Identity And Workspace Boundary

`src/features/auth/request-context.ts` exposes the small context used by routes and repositories. An active Clerk organization maps to a shared `clerk:org:<id>` Workspace. A signed-in user without an active organization maps to the personal owner Workspace `clerk:user:<id>`. Clerk roles normalize to `owner`, `admin`, or `member`.

Repositories include Workspace ID in lookup and mutation predicates, and cross-Workspace identifiers return not found. Members work with documents, DOCX interchange, AI, Proposals, Document Changes, and Conversations. Owners/admins additionally mutate prompt templates and AI settings or test saved provider credentials.

`AUTH_MODE=test` supplies a deterministic owner and Workspace for local development/tests. Production build/startup validation rejects that mode and blank Clerk keys. This fail-fast boundary must remain intact when identity is adapted.

## App And Editor UI

`src/app/` contains public sign-in/sign-up/status routes, protected pages, and JSON route handlers. `src/components/document/DocumentShell.tsx` coordinates the current draft and three-pane Workspace, while narrower modules own behavior:

- `src/features/documents/document-outline.ts`: heading outline.
- `src/features/documents/document-find.ts`: ProseMirror-position find/replace.
- `src/features/documents/tiptap-blocks.ts`: pure block transforms.
- `src/components/document/editor-block-*.ts`: block ranges, drag session, and drop target resolution.
- `src/components/document/commands/`: typed command manifest and executable registry.
- `src/components/ui/ModalSurface.tsx`: shared stack-aware focus, inertness, Escape, backdrop, and scroll-lock behavior.

Selection and command-bar AI operations capture an explicit scope and source snapshot, then create Proposals rather than directly mutating the document.

## Project Profile

`src/features/projects/` defines code-owned Profiles for typed metadata, readiness states/transitions, list filters, localized labels, and default-template references. `PROJECT_PROFILE_ID` selects one Profile for the deployment. It is never trusted from the browser and is not a per-Workspace setting. An unknown ID fails closed when the active Profile is first resolved.

Document create/update, Proposal application, metadata controls, list filters, readiness UI, and template defaults consume the same active definition. Existing unknown metadata is preserved only when unchanged so a Profile rollout does not silently destroy legacy data.

## Editor Plugins And Document Schema

`src/plugins/types.ts` defines seven build-time contribution types:

- Tiptap extensions
- selection AI commands
- slash commands
- toolbar items
- block actions
- Workspace panels
- settings sections

`src/plugins/app-plugins.ts` composes built-ins and project plugins through `createAppEditorPlugins()`. Hosts isolate factory, handler, and render failures by contribution ID instead of crashing the editor.

The browser editor and DOCX worker share `appDocumentSchemaProfileRuntime` as the build-time document schema source. UI-only contributions remain in the app plugin list, while the schema Profile itself is React-free and usable by the worker. Downstream schemas must change this shared Profile rather than maintaining a separate server list that can drift.

Read [Editor Plugins](PLUGINS.md) for the current registration pattern.

## Revision And Document Change Lifecycle

`src/features/documents/document-change-service.ts` is the consistency boundary for Proposal application and undo. Documents carry an integer revision, and draft saves, single/bulk apply, and undo require `expectedRevision`.

The client submits its current draft with Proposal application so unsaved edits are not replaced by an older server snapshot. Single apply validates the Proposal against that draft, then updates the document, accepts the Proposal, and creates a bounded Document Change in one transaction. Bulk apply validates the complete submitted Proposal set in memory and commits all statuses plus one document revision and one Document Change atomically. Any conflict leaves the batch unapplied.

Document Changes persist the before-snapshot, resulting revision, apply kind, linked Proposals, Principal, and timestamps. Server undo checks the current revision, restores the snapshot, resets linked Proposals, and marks the change undone in one transaction. Undo therefore survives reload and is not a local content-signature feature.

Stale document revisions return `409` with the latest persisted document. The client preserves the local draft and offers reload server, copy local, or save local as new. All-pending Proposal actions are withheld until Proposal pagination reaches `nextCursor: null`.

Generic `/api/proposals/:id` rejection/reset accepts optional `expectedStatus`. The official client sends it so a status race returns `409` with the current Proposal. Accepted state can be created only by the document-change apply routes and reset only by server undo.

## AI Provider And Execution Lifecycle

The side-effect-free provider catalog describes IDs, defaults, capabilities, editable settings, and reasoning options. Server adapters alone read credentials or perform network calls. Supported modes are deterministic `stub`, Core.Today `coredot`/`anthropic`/`gemini`, and direct `openai`.

`src/features/ai/ai-execution.ts` owns bounded request preflight, durable request-budget consumption, idempotency fingerprints, AI Run creation/finalization, one 30-second deadline, request abort propagation, error classification, attempt fencing, and body/secret-free telemetry. Exact completed retries replay; in-progress or mismatched key reuse conflicts. Execution tokens prevent a late timed-out attempt from finalizing newer work.

`pnpm ai:recover-stale-runs` safely marks old pending/streaming attempts interrupted and releases their execution token/lease. Deployments own scheduling and monitoring.

## Conversations And Collection Paging

The default database Conversation adapter persists Workspace/document-scoped sessions and messages. `CONVERSATION_STORAGE=local` is an explicit single-browser demo adapter. Collection routes return bounded summaries without messages; the exact transcript is loaded through `/api/conversations/:id`.

Create, append, and fork use idempotency keys. Rename, archive, status, and append use version preconditions. A version conflict returns no current version, so the client reloads detail before retrying.

Archive hides a Conversation from default lists but direct detail remains readable. `includeArchived=true` includes archived summaries. Conversation retention expiry hides both list and detail; expired individual messages are omitted from an otherwise visible transcript. These are non-destructive visibility rules, not automatic deletion.

Documents, AI Runs, Proposals, and Conversations use scoped opaque v2 cursors that bind timestamp/ID position to Workspace and route filters. Malformed or wrong-scope values return `400`. Document Change history intentionally uses a raw scoped change ID; a supplied ID that is not found or belongs to another scope returns an empty terminal page, while omitting the cursor requests the first page.

## DOCX Interchange And Resource Safety

Import first converts into an unsaved preview with warnings and a fidelity report; an idempotent confirmation creates the document. Export first previews fidelity and requires acknowledgement before output with approximated/removed features. Reports classify features as `preserved`, `approximated`, or `removed`; they do not claim full Word parity.

Request streams are byte-counted before JSON/multipart parsing. Submitted Tiptap JSON is checked iteratively for complete size, node count, and node/container depth. DOCX conversion runs in a terminable Node worker under the shared 30-second operation deadline so timed-out CPU work cannot persist or return late output.

## Database Model

`src/db/schema.ts` defines these Workspace-scoped records:

- `documents`: body, lifecycle, readiness, typed metadata, revision, optional creation key.
- `prompt_templates`: Workspace copies of built-in/custom templates.
- `ai_runs`: provider execution, idempotency fingerprint, retry lease, execution token, and bounded summaries.
- `ai_proposals`: source/replacement/explanation/range metadata and status.
- `ai_workspace_conversations` and `ai_workspace_messages`: versioned durable transcripts, links, archive, and retention metadata.
- `document_changes` and `document_change_proposals`: durable before-snapshots, revisions, apply kind, undo state, and linked Proposals.
- `app_settings`: non-secret Workspace AI settings.
- `request_budget_buckets`: durable Workspace/Principal/policy fixed-window counts.

Composite Workspace foreign keys and unique indexes keep related document, AI, Proposal, Conversation, and change records in the same scope. SQLite/libSQL is the default; a Postgres migration should preserve repository/service interfaces and the same authorization predicates.

## SQLite Today, Postgres Later

SQLite/libSQL keeps local setup and early deployments small. Move to Postgres when concurrency, reporting, database-native row-level security, or operating requirements demand it. Replace the Drizzle table/client implementation behind repository interfaces, preserve Workspace predicates and serialized document-change transactions, regenerate migrations, and rerun repository/concurrency tests against the target database.

## Test And Release Gate

Repository tests use temporary databases, route tests exercise auth/error contracts, component tests use Testing Library, and Playwright uses an isolated E2E database. Production smoke builds and starts the artifact against a temporary migrated database and verifies health, readiness, redirects, and protected-route behavior.

Production builds intentionally require Clerk-mode configuration. Use the verification-only test-format environment documented in [Configuration](configuration.md#production-verification), then run:

```bash
pnpm release:check
pnpm e2e:production
.venv-docs/bin/python -m mkdocs build --strict
git diff --check
```

The dependency audit blocks the configured moderate-or-higher threshold; it is not an all-severity zero-finding claim.

## Extension Points

- Replace Clerk behind the request-context adapter while preserving fail-closed production validation, roles, and repository Workspace predicates.
- Replace SQLite/libSQL behind repositories without bypassing serialized/atomic document changes.
- Add providers through the catalog, server adapter, and contract tests.
- Customize domain fields and workflow through Project Profiles rather than one-off UI branches.
- Register build-time UI contributions through `createAppEditorPlugins()` and change document nodes through the shared app schema Profile.
- Extend prompt templates while keeping variable and structured Proposal contracts.
- Add real-time collaboration only with an explicit synchronization model that interoperates with revision/document-change semantics.
- Extend DOCX fidelity with corpus tests and explicit report classifications.
