# Architecture Hardening Design

This design turns Coredot Editor from a strong single-user starter into a safer, reusable editor foundation for real projects. Work is delivered in four independently verifiable batches so security, data integrity, runtime reliability, and extensibility do not become one unreviewable change.

## Design Goals

- Fail closed before private documents or paid AI calls are exposed.
- Keep every persisted resource inside one Workspace.
- Make document changes conflict-aware and transactionally consistent.
- Put provider lifecycle, deadlines, recovery, and telemetry behind one AI execution interface.
- Make advertised extension interfaces render real behavior.
- Expose document-format loss before users trust imported or exported files.
- Preserve deterministic local development and automated tests.

## Non-Goals

- Real-time collaborative editing is not introduced in this program.
- Microsoft Word layout parity, native tracked changes, and Office.js integration remain separate product work.
- Runtime-loaded third-party plugins are not allowed; Editor Plugins stay build-time and auditable.
- Project Profiles are code-defined in this program rather than edited through an administrative UI.

## Batch A: Deployment Safety And Workspace Ownership

### Clerk request context

The application uses Clerk's App Router integration for sign-in, sign-up, server authentication, and organization membership. Clerk is isolated in an authentication adapter that produces a small request context containing:

- Principal ID
- Workspace ID
- Workspace Role
- request ID
- authentication mode

An active Clerk organization maps to a shared Workspace. A signed-in Principal without an active organization maps to a personal Workspace derived from the Clerk user ID. Personal Workspace requests have the owner role. A deterministic test adapter supplies fixed identities only when the explicit test authentication mode is active; production cannot enable this adapter.

The home page, public documentation links, sign-in, and sign-up remain public. Document, template, settings, AI, proposal, conversation, import, and export pages and route handlers require an authenticated request context.

### Authorization policy

Repositories require Workspace context and include Workspace ID in every lookup and mutation condition. Route handlers do not fetch a record by naked ID and authorize it afterward.

- Members can list, create, read, edit, archive, import, and export documents; run AI commands; and manage Proposals and Conversations.
- Owners and admins can additionally manage prompt templates and AI settings. Project Profile selection is a server deployment setting, not a workspace mutation.
- Personal Workspace Principals act as owners.
- Cross-Workspace access returns not found so record existence is not disclosed.

The following records become Workspace-owned: documents, prompt templates, AI settings, AI Runs, Proposals, Conversations, Conversation messages, Document Changes, rate-limit buckets, and any future retrieval collections.

Built-in templates are copied into a Workspace by an idempotent bootstrap module rather than shared as mutable global records. Existing unscoped records migrate to the local Workspace. An explicit command moves local records to a selected Clerk Workspace; production never claims them implicitly.

### Request protection

A durable fixed-window rate-limit module uses Workspace and Principal identifiers. Default policies cover AI review/rewrite, provider connection tests, DOCX import/export, and document creation. Limits return `429` with a retry time.

DOCX and JSON request policies enforce byte size, document node count, nesting depth, and processing deadline before expensive conversion. Oversized work returns `413`; deadline expiry returns `408` or `504` according to whether processing started.

Dependency advisories at moderate or higher severity block completion. Runtime dependencies take priority over development-only findings, but the checked-in release gate must finish with zero findings at its configured threshold.

### Batch A acceptance

- Unauthenticated protected requests fail.
- Cross-Workspace reads and writes fail without revealing record existence.
- Members and admins receive the documented permissions.
- Production cannot start in test authentication mode.
- Rate-limit and resource-limit tests are deterministic.
- The security audit passes at the release threshold.

## Batch B: Document Revision And Change Lifecycle

### Revision contract

Each Document Draft has an integer Document Revision. Every persisted document mutation includes the caller's expected revision. The repository updates with both document ID and expected revision, increments the revision, and returns either the saved draft or a conflict containing the latest persisted snapshot.

Autosave no longer relies on request order inside one browser tab. A second tab or client with an old revision receives `409`, keeps its local draft, and is offered three explicit choices: reload the server draft, copy the local draft, or save the local draft as a new document. No automatic merge is attempted.

### One document-change module

A deep document-change module owns autosave, Proposal acceptance, atomic bulk acceptance, rejection, and server-side undo. The UI submits the current Document Draft and expected revision when applying a Proposal, so unsaved edits are not replaced by an older server snapshot.

Accepting a Proposal creates a Document Change in the same transaction that updates the document and Proposal. A Document Change stores a bounded before snapshot, the resulting revision, apply mode, Proposal link, Principal, and timestamp. Undo verifies the current revision, restores the before snapshot, marks the Proposal pending, and marks the Document Change undone in one transaction.

Bulk acceptance is all-or-nothing. The module orders range-backed Proposals, validates every Proposal against the submitted draft, applies them in memory, then commits one document revision and all Proposal statuses in one transaction. A conflict leaves every Proposal pending.

Client content signatures remain useful for transient selection and drag sessions, but persisted consistency uses Document Revision only.

### Batch B acceptance

- Two-tab stale autosave cannot overwrite a newer revision.
- Accepting a Proposal preserves unsaved edits submitted with the current draft.
- Accept, bulk accept, and undo update document and Proposal records atomically.
- Undo survives reload because its state is server-owned.
- UI tests consume the same document-change interface used in production.

## Batch C: AI Runtime And Operational Reliability

### Provider catalog and adapters

A side-effect-free provider catalog is the source of truth for provider identity, labels, defaults, capabilities, editable settings, and supported reasoning options. UI and validation read the catalog; only server adapters read credentials or perform network calls.

The existing stub, Core.Today proxy modes, and direct OpenAI mode remain adapters behind the same provider interface. Adding a provider requires one catalog entry, one server adapter, and contract tests rather than synchronized branches across UI, persistence, and runtime.

### AI execution lifecycle

A deep AI execution module owns:

- preflight document, template, variables, references, and authorization
- rate-limit consumption
- idempotency key handling
- AI Run creation and finalization
- request deadline and abort propagation
- provider error classification
- structured telemetry without document bodies or secrets
- stale pending-run recovery

Review and rewrite routes retain only operation-specific payload validation, prompt construction, and result-to-Proposal mapping. Client disconnects and server deadlines abort provider work when supported. Expired pending runs are marked failed by a recovery command that is safe to rerun.

### Database and production proof

One database credential resolver supplies URL and optional auth token to both the runtime client and migrations. Local SQLite remains the default. Hosted libSQL configuration is verified by a canary integration test that is opt-in outside CI secrets.

Production verification starts a built artifact with `next start`, exercises health and readiness routes, and runs a smoke flow. Health reports process availability; readiness checks database access and migration compatibility without exposing credentials. E2E coverage adds a production-server job, two-tab conflict flow, provider timeout contract, and migration-from-previous-version check.

### Batch C acceptance

- Provider defaults and capabilities come from one catalog.
- AI calls have enforced deadlines and abort signals.
- Duplicate idempotency keys do not create duplicate AI Runs.
- Stale pending runs are recoverable.
- Structured logs contain identifiers and timing but not document text or secrets.
- Runtime and migration clients accept the same hosted database credentials.
- Production artifact smoke tests pass.

## Batch D: Extensibility And User Trust

### Editor Plugin host and schema profile

All advertised Editor Plugin contributions become real or are removed. This program implements rendered toolbar items, block actions, workspace panels, and settings sections with stable IDs, localized labels, enablement, ordering, and executable or render behavior. The host catches plugin failures locally and reports the plugin ID without crashing the editor.

Browser-only contributions are separated from a server-safe document schema profile. The editor, import, and export modules receive the same schema profile, so downstream nodes do not silently disappear only because conversion used the core schema.

### Block movement

The block-movement module accepts a normalized move intent and returns the changed document plus the resolved destination needed for caret and focus restoration. Parent paths, list conversion, index adjustment, and destination calculation stay inside the module. `DocumentEditor` coordinates pointer state and applies the returned result without reimplementing coordinate rules.

### Document Interchange

Import and export return a structured fidelity report that classifies each unsupported feature as preserved, approximated, or removed. Import warnings are shown before the user begins editing. Export runs a preview step and requires acknowledgement when loss exists.

Document Interchange adapters enforce the resource policy from Batch A. DOCX corpus tests cover headings, nested lists, task items, marks, links, tables, Korean text, unknown nodes, and oversized input.

### Conversation persistence

A Conversation repository seam has two adapters: local browser storage for explicit demo mode and database persistence for authenticated workspaces. Both adapters return success or failure, enforce session and message limits, and support archive, rename, and fork operations. The UI never labels a Conversation saved until the adapter confirms it.

Database Conversations and messages carry Workspace ID, Document ID, nullable AI Run and Proposal links, timestamps, archive state, and retention metadata. Private document text is not copied into general logs.

Collection endpoints return stable opaque cursor pages ordered by `(updatedAt, id)` or `(createdAt, id)`. Conversation list items never contain message bodies; the selected transcript is fetched through a scoped detail endpoint and can be retried independently. Loading an older page appends only unseen IDs so optimistic or already-mutated sessions are not overwritten by stale summaries. Retention is deliberately non-destructive in this release: no background task prunes audit records, pending work, or foreign-key targets.

### Project Profile

A code-defined Project Profile supplies metadata fields, readiness states and allowed transitions, list filters, labels, and default template references. The editor metadata panel, document list, validation, and template defaults derive from this one definition.

The default profile preserves today's owner, due date, category, tags, and four readiness states. Example profiles demonstrate legal review and research writing without changing the host modules.

The active Profile is selected once per deployment through server-only `PROJECT_PROFILE_ID`. Unknown IDs fail fast. There is no per-Workspace Profile selector in this release.

### Shared modal surface

Settings dialogs, command palette, interchange confirmations, and both compact workspace drawers reuse one stack-aware accessible modal-surface module for initial focus, focus containment, topmost-only Escape/backdrop handling, focus restoration, background inertness, scroll locking, and global shortcut suppression.

### Batch D acceptance

- Every public Editor Plugin contribution is rendered and covered by a host test.
- Editor and Document Interchange use the same schema profile.
- Block movement tests assert content and resolved focus destination through one interface.
- Users see import/export fidelity loss before trusting the artifact.
- Authenticated Conversations survive reload and browser changes.
- Project-specific fields require one Project Profile change rather than coordinated UI edits.
- Keyboard focus cannot escape active modal surfaces.

## Delivery And Verification

Each batch is developed test-first in an isolated worktree and reviewed for specification compliance before code quality. A batch is not complete until its focused tests, typecheck, lint, full unit suite, E2E suite, production build, security audit, documentation build, and `git diff --check` are green where applicable.

The final release gate is:

```bash
pnpm release:check
pnpm docs:build
git diff --check
```

Documentation build setup must be reproducible through the pinned documentation requirements and documented virtual environment command. No internal planning artifacts or generated documentation output are committed.
