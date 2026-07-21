# API Reference

These app-internal JSON contracts are documented so downstream forks can keep UI, tests, and integrations aligned. Protected routes resolve a Clerk or deterministic test request context and scope every lookup and mutation to its Workspace. Cross-Workspace IDs return not found.

Workspace members can work with documents, imports/exports, AI Runs, Proposals, Document Changes, and Conversations. Prompt-template and AI-settings mutations, including provider connection tests, require `owner` or `admin`.

## Documents

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/documents` | `GET` | List active document summaries with an opaque cursor, bounded limit, and Profile-derived typed filters. |
| `/api/documents` | `POST` | Create a document; a full-draft request may use `Idempotency-Key` for replay-safe creation. |
| `/api/documents/:id` | `GET` | Load one document. |
| `/api/documents/:id` | `PUT` | Save legacy title, content, and metadata with `expectedRevision`; readiness is rejected because workflow state has its own authority boundary. A stale revision returns `409` and the latest saved document. An initialized collaborative document returns `409 collaboration_initialized`. |
| `/api/documents/:id/workflow` | `GET` | Read uncached server-authoritative readiness, document revision, and the current collaborative generation/head when present. |
| `/api/documents/:id/workflow` | `POST` | Compare-and-set readiness. Approval additionally requires an exact observed collaborative head and is unsupported for unversioned legacy documents. |
| `/api/documents/:id/collaboration-capability` | `POST` | Issue a short-lived signed collaboration capability for the document's current room. The first successful issue initializes collaboration for the document. Requires an empty body; returns `{ token, room, expiresInSeconds: 60 }`. Errors carry a stable `reason`: a nonempty body returns `400 invalid_request`, unknown or cross-Workspace documents return `404 not_found`, and signing-configuration or storage failures return `503 unavailable` with `Retry-After`. |
| `/api/documents/:id` | `DELETE` | Atomically archive a document and enqueue closure of its current collaboration room. Success reports `roomClosure` as `not_required`, `delivered`, or `pending`. |
| `/api/documents/import` | `POST` | Convert a multipart `.docx` into an unsaved preview with warnings and a fidelity report, or confirm its JSON preview with an `Idempotency-Key` to create the document. |
| `/api/documents/:id/export/preview` | `POST` | Inspect export fidelity. An initialized collaborative document ignores submitted content and previews its exact canonical Yjs snapshot. |
| `/api/documents/:id/export` | `POST` | Export `.docx`; initialized collaboration ignores submitted title/content and uses the exact canonical Yjs snapshot. Lossy output requires `acknowledgedLoss`, otherwise the route returns `409` with the fidelity report. |

Import confirmation is deliberately separate from conversion so warnings are visible before persistence. Fidelity outcomes are `preserved`, `approximated`, or `removed`; they do not imply full Word layout parity.

Non-approval workflow commands contain exactly `expectedReadiness` and `nextReadiness`. Approval contains exactly `expectedReadiness: "ready"`, `nextReadiness: "approved"`, and non-negative `observedHeadSeq`. The server validates the active Project Profile and performs the readiness compare-and-set in the same transaction. Collaborative approval also records the exact generation, head, Yjs state vector, and canonical content hash. A later changed Yjs update atomically invalidates that approval and returns readiness to `needs_review`; a canonical no-op does neither. Every successful collaborative HTTP transition atomically coalesces a durable notification job by Workspace/document. The job carries only exact generation, workflow revision fencing, and bounded delivery state; a sidecar retries the fixed stateless signal at least once without exposing readiness or document content. Notifications are only hints to re-read this endpoint.

Archive success is durable even when the collaboration sidecar is temporarily unavailable. The normal Next.js process has no local room gateway, so it commits the archive and a due-now closure job with `attempts: 0`, returns `roomClosure: "pending"`, and leaves the full bounded retry budget to the sidecar reconciler. Only a process configured with a real room gateway attempts immediate delivery. All production archive entry points use this transactional service; the general document repository exposes no status-only archive writer. Clients must stop treating the archived room as writable regardless of immediate delivery status.

## Templates

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/templates` | `GET` | List prompt templates. |
| `/api/templates` | `POST` | Create a prompt template as an owner/admin. |
| `/api/templates/:id` | `PUT` | Update a prompt template as an owner/admin. |
| `/api/templates/:id` | `DELETE` | Archive a prompt template as an owner/admin. |

Template payloads are validated against `src/features/templates/template-validation.ts`. Variable schemas drive UI input rendering and server validation.

## AI Settings

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/settings/ai` | `GET` | Read non-secret AI runtime settings plus secret-presence booleans. |
| `/api/settings/ai` | `PUT` | Save non-secret provider, model, Base URL, token, and reasoning settings as an owner/admin. |
| `/api/settings/ai/test` | `POST` | Test server-side provider configuration as an owner/admin. Limited to 5 attempts per minute per Workspace Principal and aborted after 30 seconds. |

API keys are neither accepted nor returned through these routes.

## AI Commands

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/ai/review` | `POST` | Run a structured review and persist Proposals. |
| `/api/ai/rewrite` | `POST` | Run a selected-text, current-block, or document-level rewrite and persist a Proposal. |

Both routes share Workspace-scoped preflight, request budgets, one 30-second operation deadline, disconnect/timeout abort propagation, AI Run lifecycle, and structured telemetry that excludes document bodies and secrets. `Idempotency-Key` accepts 1–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`; the server generates a key when the header is absent. An exact completed replay returns the stored public result, an in-progress duplicate or reuse for different input returns `409`, and timed-out/aborted attempts are fenced from late finalization.

An initialized collaborative document requires `collaborationBarrier: { generation, stateVector }`; `stateVector` is canonical unpadded base64url. The browser obtains it only after flushing and durably acknowledging all local updates. The server ignores client-submitted whole-document text, loads the exact durable Yjs snapshot, and atomically binds the AI Run to its document/generation/head/state-vector/schema/content-hash identity. Missing, stale, malformed, legacy-only, or mismatched barriers return `409 collaboration_snapshot_conflict`; retryable storage failure returns `503 collaboration_snapshot_unavailable`. Collaborative rewrite also requires the exact ProseMirror `selectionRange`. Reference documents remain fenced SQL projections and carry generation/`projectedSeq` diagnostics rather than exact-snapshot guarantees.

Legacy AI claim and finalization transactions require that no current collaboration generation exists. A collaboration cutover during provider execution rolls finalization back before any anchorless Proposal is inserted, then the fenced execution attempt is failed. Cutover also marks pre-existing pending legacy Proposals `rejected` while retaining them as history, so the Proposal list never presents numeric-position legacy work as applicable to canonical Yjs state.

## Proposals And Document Changes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/documents/:id/proposals` | `GET` | List bounded Proposal previews ordered by `(createdAt, id)` with an opaque cursor. |
| `/api/proposals/:id` | `GET` | Load one exact Workspace-scoped Proposal when a preview was truncated. |
| `/api/proposals/:id/apply` | `POST` | Legacy: apply to a submitted draft with `expectedRevision`. Collaboration: apply one anchored Proposal with only `commandId`, `proposalId`, `mode`, and `observedHeadSeq`. |
| `/api/proposals/bulk-apply` | `POST` | Legacy: apply submitted draft Proposals. Collaboration: atomically apply ordered semantic `{ proposalId, mode }` items with `commandId` and `observedHeadSeq`. |
| `/api/proposals/:id` | `PATCH` | Reject or reset Proposal status. `expectedStatus` is optional in the route contract; the official client sends it for conflict protection. |
| `/api/document-changes` | `GET` | List Workspace-scoped Document Changes using the previous page's raw change ID as `cursor`; a supplied ID that is not found or belongs to another scope returns an empty terminal page. |
| `/api/document-changes/:id/undo` | `POST` | Restore the bounded before-snapshot and reset linked Proposals atomically with `expectedRevision`. |

The generic Proposal `PATCH` route rejects `accepted`; acceptance must use the transactional apply routes. After collaboration initialization, a `rejected` Proposal may return to `pending` only when it has an anchor for the exact current document generation. An anchorless legacy Proposal or an anchor from a superseded generation returns `409 collaboration_anchor_required` and remains rejected. Legacy documents retain the existing reset behavior. A stale revision returns `409` without partially changing Proposal status. Clients may offer an all-pending bulk action only after Proposal pagination reaches `nextCursor: null`, so the request cannot silently omit unloaded pending items.

Collaborative apply never accepts a full draft or readiness value. `observedHeadSeq` may be behind the live head because unrelated edits do not invalidate a relative anchor, but it cannot be ahead. The server resolves both stored Yjs relative positions and verifies generation, schema, body fragment, forward order, and target hash before mutation. A stale or changed target returns `409 proposal_target_conflict`; an overlapping batch returns `409 proposal_overlap_conflict`; all content and Proposal statuses remain unchanged. The exact update, semantic action, projection, Proposal statuses, Document Change, delivery outbox, and workflow notification commit in one transaction. Exact command replay is idempotent and can re-arm an exhausted matching delivery; command-id reuse with another fingerprint returns `409 idempotency_conflict`.

Successful initialized-document export preview JSON includes `collaboration: { generation, headSeq, schemaFingerprint, contentHash }`. Successful DOCX responses expose the same values as `X-CoreDot-Collaboration-Generation`, `X-CoreDot-Collaboration-Head-Seq`, `X-CoreDot-Collaboration-Schema-Fingerprint`, and `X-CoreDot-Collaboration-Content-Hash`. Fidelity acknowledgement failures include the diagnostics in JSON. `409 collaboration_state_conflict` and `503 collaboration_state_unavailable` fail closed instead of falling back to a submitted draft.

## AI Runs And Conversations

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/documents/:id/ai-runs` | `GET` | List bounded AI Run summaries ordered by `(createdAt, id)`; input/output bodies are omitted. |
| `/api/documents/:id/conversations` | `GET` | List bounded Conversation summaries ordered by `(updatedAt, id)`; message bodies are omitted. |
| `/api/documents/:id/conversations` | `POST` | Create a Conversation with a required creation `Idempotency-Key`; the initial user message carries its own mutation key. |
| `/api/conversations/:id` | `GET` | Load the exact Workspace-scoped transcript for one selected Conversation. |
| `/api/conversations/:id` | `PATCH` | Rename, archive/unarchive, or change status with `expectedVersion`. |
| `/api/conversations/:id/messages` | `POST` | Append one bounded message with `expectedVersion` and a required `Idempotency-Key`. |
| `/api/conversations/:id/fork` | `POST` | Fork through a selected message with a required `Idempotency-Key`. |

Archive removes a Conversation from default lists; `includeArchived=true` includes it, and direct detail remains readable. Conversation retention expiry hides both list and detail, while an expired individual message is omitted from an otherwise visible transcript. Neither expiry path deletes records automatically. List cursors are bound to the document, Workspace, and `includeArchived` filter. A Conversation mutation version conflict returns only a stable conflict reason, so the client must reload detail to obtain the current version before retrying. The database adapter is the durable default. `CONVERSATION_STORAGE=local` is an explicit single-browser demo adapter, not a cross-browser persistence mode.

## Collection Cursors

Documents, AI Runs, Proposals, and Conversations share non-empty, opaque version-2 cursors containing a timestamp/ID position and a fingerprint of the Workspace plus route filters. Clients should follow `nextCursor`, append unseen IDs, and treat `null` as the terminal page. Restart from the first page when filters change. A malformed or wrong-scope v2 cursor returns `400`; it never silently broadens a collection.

Document Change history is the exception: its cursor is a raw, Workspace/document-scoped change ID. When a supplied ID is not found or belongs to another scope, the route returns an empty page with `nextCursor: null` rather than a v2 cursor error. Omitting `cursor` still requests the first page.

## Operational Status

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/health` | `GET`, `HEAD`, `OPTIONS` | Public, no-store process liveness without database access. |
| `/api/ready` | `GET`, `HEAD`, `OPTIONS` | Public, bounded database and migration-compatibility readiness without credential disclosure. |

## Error Shape

Most invalid requests return:

```json
{ "error": "Invalid request body" }
```

Machine-readable error codes use two route-family vocabularies. Document command routes — workflow, collaboration-capability, Proposal apply and bulk-apply, and Document Change undo — return a stable `reason` token beside `error`; all of them use the shared token `unavailable` (a `503` with `Retry-After`) when collaboration persistence is temporarily unavailable. Export, export preview, and AI snapshot responses return `code` values instead; their `collaboration_state_unavailable` and `collaboration_snapshot_unavailable` name that same temporary-unavailability condition for exact-snapshot reads.

Expected-state and revision conflicts use `409` and expose only bounded public recovery data. Document revision conflicts include the latest document, Proposal status conflicts include the current Proposal, and Conversation conflicts include a stable reason but not the current version—reload Conversation detail before retrying. Authentication/authorization, limits, deadlines, and missing scoped resources retain their normal `401`/`403`, `413`/`429`, `408`/`504`, and `404` meanings.
