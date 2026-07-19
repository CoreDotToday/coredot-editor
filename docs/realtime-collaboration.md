# Real-Time Collaboration Design

**Status:** Accepted for implementation review
**Date:** 2026-07-19

Coredot Editor will support real-time document collaboration through Yjs and a separately deployable, self-hosted Hocuspocus v4 server. This design keeps rich-text editing responsive while preserving the existing Workspace authorization, Project Profile validation, AI Proposal, Document Change, and release-safety contracts.

This page is the implementation specification. [ADR 0002](adr/0002-use-yjs-and-hocuspocus-for-real-time-collaboration.md) records why this stack was selected.

## Outcomes

The first collaboration release must provide:

- Concurrent editing of the Tiptap body, title, and Project Profile metadata.
- Shared cursors, selections, and an accessible participant list.
- Automatic merging after a temporary connection loss while the browser tab remains open.
- Server-authoritative readiness and approval transitions.
- Durable Yjs state, deterministic crash recovery, and a bounded materialized SQL view.
- AI review, Proposal application, and Document Change undo that remain safe during concurrent edits.
- Clerk-backed Workspace isolation for WebSocket connections and server commands.
- A deployment-neutral application seam with a self-hosted Hocuspocus adapter.

## Non-Goals

The first release does not include:

- Browser persistence after a tab is closed. `y-indexeddb` is intentionally excluded.
- Peer-to-peer WebRTC collaboration.
- Horizontal Hocuspocus deployment or a Redis adapter.
- A Y-Sweet adapter or S3-backed collaboration store.
- Forced undo that overwrites a concurrently edited target.
- Collaborative control of readiness, approval, archive state, or permissions.
- Automatic fallback from an initialized collaborative document to legacy revision autosave.

## System Shape

```text
Browser
  CollaborationSession
    Y.Doc
      body: Y.XmlFragment
      title: Y.Text
      metadata: Y.Map
    Hocuspocus provider adapter
    Awareness
        |
        | WSS, short-lived collaboration capability
        v
Hocuspocus v4 sidecar (Node.js 22+)
  authentication and token synchronization
  verified Awareness stamping
  per-document sequencer
  collaborative command gateway
  update validation and persistence
        |
        v
Drizzle persistence
  Yjs checkpoints and update log: canonical document state
  documents row: materialized read model and server workflow state
  AI Proposals and Document Changes: semantic action records
```

The Next.js application issues collaboration capabilities and owns normal HTTP application commands. It does not terminate production WebSocket connections. Hocuspocus runs as a separate process so the web application and stateful collaboration tier can deploy and scale independently.

## Deep Modules And Seams

### Collaboration Session

The browser uses one `CollaborationSession` interface. Callers may observe connection status, the synchronized Y.Doc, verified participants, durable head acknowledgements, and lifecycle events. Callers may connect, disconnect, request a token refresh, and flush pending updates before a snapshot-dependent command.

The interface does not expose Hocuspocus configuration or provider events. A Hocuspocus adapter translates those details. Disabled mode keeps the existing single-user document session rather than pretending to be a collaborative adapter.

### Collaboration Document Codec

`CollaborationDocumentCodec` is the only module that understands the shared Y.Doc layout and Tiptap conversion. It:

- Bootstraps a Y.Doc from an existing SQL document exactly once.
- Materializes body JSON, title, metadata, and plain text from a Y.Doc.
- Encodes and decodes canonical Yjs binary checkpoints.
- Calculates a document schema fingerprint.
- Validates the complete candidate document against resource and Project Profile limits.
- Converts between ProseMirror positions and Yjs relative positions.

JSON is never converted back into an initialized Y.Doc during ordinary load. Repeating that conversion would create a new collaboration history and can duplicate content.

### Collaborative Document Gateway

All server-originated mutations of an initialized collaborative document use one `CollaborativeDocumentGateway`. Its interface supports:

- Reading an exact live snapshot with `headSeq`, state vector, generation, and schema fingerprint.
- Applying one Proposal or an atomic Proposal batch.
- Undoing one collaborative Document Change.
- Materializing or exporting an exact live snapshot.
- Broadcasting a server workflow notification after a committed server-authoritative change.

The gateway hides Hocuspocus Direct Connection and Yjs transaction mechanics. Existing REST routes delegate to it when collaboration is initialized. They may not write collaborative body, title, or metadata directly.

### Collaboration Persistence

`CollaborationPersistence` owns the durable update protocol, sequence fencing, checkpointing, projection, and recovery. It uses the existing Drizzle database and contention retry policy. The Hocuspocus SQLite extension is not used because it would introduce a second, incompatible storage model.

## Canonical State And Data Model

Yjs binary state is canonical for collaborative body, title, and metadata. The `documents` row remains canonical for readiness, approval effectiveness, archive status, and Workspace ownership. Its collaborative body fields are a materialized read model for lists, search, non-interactive reads, and compatibility.

### Collaboration Document

A `collaboration_documents` record is scoped by Workspace, document, and generation and contains:

- `generation`: advances only through a server-authoritative, audited transition. A storage-budget rotation preserves the logical Yjs state in the new generation, while an explicit destructive reset starts a new canonical Yjs state.
- `isCurrent`: exactly one generation per Workspace/document may be current.
- `schemaVersion` and `schemaFingerprint`.
- `checkpointBlob` and `checkpointChecksum`.
- `headSeq`: last durably appended Yjs update.
- `checkpointSeq`: last update included in the checkpoint.
- `projectedSeq`: last update included in the SQL document projection.
- timestamps and last checkpoint metrics.

The required invariant is:

```text
0 <= checkpointSeq <= projectedSeq <= headSeq
```

Projection may temporarily lag the live document, but every interactive snapshot consumer uses the collaborative gateway rather than assuming that the SQL projection is current.

Both generation transitions retire generation N and insert generation N+1 in one server-authoritative transaction. A storage-budget rotation checkpoints and carries the existing logical Yjs state into N+1; a destructive reset replaces it only through the explicit reset path. Retired generations and their child rows remain available for audit in either case. Current reads use the partial current-generation index; history reads filter by Workspace/document and order the generation index by `generation DESC`.

Canonical persistence limits are deliberately below the general SQLite value boundary: checkpoints, updates, and inverse updates are at most 10 MiB; state vectors are at most 1 MiB; relative positions are at most 64 KiB; diagnostic JSON objects are at most 4 KiB; target previews are at most 1 KiB; failure categories are at most 128 bytes; and command/idempotency keys are at most 256 bytes. Binary values must use SQLite BLOB storage and be non-empty. Hashes must use TEXT storage and contain exactly 64 lowercase hexadecimal characters. Text limits are measured as UTF-8 bytes.

### Collaboration Update

`collaboration_updates` is an append-only, Workspace-scoped log. Each record contains:

- Document generation and monotonic sequence.
- Yjs update binary and checksum.
- Stable action or message idempotency key.
- Origin kind: client, Proposal command, undo command, migration, or repair.
- Principal, request, session, and semantic action identifiers where applicable.
- Creation time and bounded diagnostic metadata without document content.

The unique keys prevent replayed provider messages or server commands from allocating a second sequence. Applying the same Yjs update more than once must remain harmless.

### Collaboration No-op Receipt

`collaboration_noop_receipts` records accepted updates that do not change the canonical Yjs checkpoint. A receipt keeps the document-wide idempotency key, input checksum, origin and audit identity, and the exact generation and head observed when the no-op was accepted. It does not allocate a new update sequence or invalidate approval/readiness. Exact retries therefore return the saved `generation` and `headSeq` even after later appends or a storage rotation.

The receipt primary key is Workspace/document/idempotency key, so the key remains owned across generations. Replay checks both `collaboration_noop_receipts` and `collaboration_updates`; a key found in both sources, more than once in the update history, or beyond its retained generation head is treated as corrupt state. Migration `0016_collaboration_noop_receipts` intentionally does not backfill receipts because pre-migration no-op requests cannot be reconstructed safely. Existing changed-update idempotency records remain replayable from `collaboration_updates` as the compatibility fallback.

### Collaboration Action

`collaboration_actions` gives binary updates semantic audit meaning. It records the command id, action type, Principal, request id, base and applied head sequence, related Proposal or Document Change ids, status, and bounded failure category. It does not store prompt bodies, document text, credentials, or Awareness payloads.

### Proposal Anchors

Collaborative Proposals add:

- Encoded start and end `Y.RelativePosition` values with explicit association.
- Base Yjs state vector, head sequence, document generation, and schema fingerprint.
- Target text hash and bounded preview.

Existing numeric positions and occurrence indexes remain only for non-collaborative compatibility and historical display. Collaborative apply never falls back to an occurrence index when an anchor is stale.

### Collaborative Document Change

A collaborative Document Change adds:

- Forward update sequence and action id.
- Durable inverse Yjs update.
- Relative affected-range anchors and postcondition fingerprint.
- Base and resulting head sequence.
- Existing Proposal links and bounded before snapshot for audit and comparison.

The before snapshot is not executable undo state in collaboration mode.

### Approval Record

Approval is version-bound. A `document_approvals` record includes:

- Approved document head sequence, state vector, and content hash.
- Approving Principal and request id.
- Approval time.
- Invalidation update sequence, Principal, and time when superseded.

The effective `documents.readiness` remains server-owned.

## Durable Update Protocol

### Client Update

For each provider update, the sidecar:

1. Revalidates token expiry, authorization epoch, room binding, and write permission.
2. Acquires the document sequencer.
3. Encodes the current canonical checkpoint, applies the update to a clone of the current Y.Doc, validates the complete candidate, and encodes the candidate checkpoint.
4. Compares the complete checkpoint bytes, including unresolved Yjs `pendingStructs` and `pendingDs`. A byte-identical candidate stores a no-op receipt without advancing the head; a pending-only dependency difference remains a durable update.
5. For a changed candidate, validates update bytes, title, metadata, Tiptap resource limits, schema fingerprint, and complete Project Profile state, then atomically allocates `headSeq` and appends the update and audit envelope.
6. If the current document is approved, invalidates that approval and changes readiness to `needs_review` in the same transaction.
7. Allows Hocuspocus to apply and broadcast the already durable update.
8. Releases the sequencer after the Hocuspocus message lifecycle finishes.

If durable append succeeds but live apply fails, the room is closed. Reconnection reloads the canonical checkpoint plus all later updates. The server never rolls the database back to match stale memory.

Provider-side batching may reduce write frequency, but batching latency and payload size stay bounded. `onStoreDocument` is not the per-update durability seam because it is debounced.

### Server Command

Proposal apply and undo use a durable-first staged command:

1. Acquire the document sequencer and open a Hocuspocus Direct Connection.
2. Clone the canonical Y.Doc at the current head.
3. Resolve and validate the command against the clone.
4. Calculate the exact forward update, inverse update when applicable, materialized result, and semantic postconditions.
5. In one SQL transaction, compare-and-set the head sequence, append the update and action, update Proposal state, create or undo the Document Change, and persist the required projection or workflow changes.
6. Apply the committed update to the live document with a structured server origin containing the action id.
7. Broadcast through the normal Hocuspocus path.

If the SQL transaction fails, the live document is unchanged. If live application or broadcast fails after commit, the durable action remains authoritative and the room reload or reconciler applies it idempotently.

### Checkpoint And Projection

Checkpointing encodes the full Y.Doc and persists its checksum and `checkpointSeq`. Projection materializes title, body JSON, metadata, plain text, and a materialized revision with `projectedSeq` fencing. A checkpoint transaction projects at least the same through-sequence, preserving `checkpointSeq <= projectedSeq`.

Compaction deletes or archives update rows only after the checkpoint transaction commits. Recovery always loads the checkpoint and applies updates with `seq > checkpointSeq` in order. A checksum, generation, or schema mismatch fails readiness and requires an explicit repair path; it never silently bootstraps from JSON.

## AI And Proposal Lifecycle

AI review and rewrite begin with a synchronization barrier:

1. The initiating browser flushes pending provider updates.
2. The server reads the exact canonical snapshot through the collaborative gateway.
3. The AI Run records the snapshot head sequence, state vector, schema fingerprint, and bounded content hash.
4. Proposal targets are converted into Yjs relative anchors against that snapshot.

Apply requests contain only Proposal ids, apply modes, a command id or idempotency key, and an observed head sequence. They do not contain a full draft or readiness value.

The observed head is diagnostic context rather than a document-wide compare-and-set. An unrelated update may advance the head without invalidating a Proposal. The resolved relative anchors, generation, schema, and target postconditions decide whether apply is safe.

At apply time, both relative anchors must resolve into the body fragment in forward order and the current target must match its stored hash. A missing, reversed, wrong-fragment, wrong-generation, wrong-schema, or text-mismatched anchor returns a stable `proposal_target_conflict`. The Proposal remains pending.

A batch is one Yjs transaction and one durable action. Every Proposal must validate before any update is committed. Overlapping ranges return `proposal_overlap_conflict`; the server does not guess a reordering policy.

## Selective Undo

Whole-document snapshot restoration is unsafe because it can erase unrelated concurrent work. Collaborative undo instead stores an exact inverse update at apply time.

The implementation uses a shadow Y.Doc and a command-only `Y.UndoManager` origin with capturing boundaries. It applies the proposed command, captures the forward update, immediately performs undo in the shadow document, and captures the inverse update. The UndoManager stack is discarded; only the tested inverse update and its postconditions are durable.

Undo resolves the affected anchors against the current document and verifies the postcondition fingerprint. If the target was changed after apply, the command returns `undo_conflict`. Otherwise, the inverse becomes a new canonical update and the Proposal statuses and Document Change state transition atomically.

Batch undo is all-or-nothing through one stored inverse. A future privileged force operation would require its own authorization and audit design and is not part of this release.

If exact inverse generation cannot pass pinned-version restart, garbage-collection, and concurrent-edit tests, collaborative server undo remains disabled. The implementation must never fall back to whole-document restoration.

## Server-Authoritative Workflow

Readiness and approval do not live in a client-writable Yjs type. Existing Project Profile transition and authorization checks remain server-side.

Approval binds to the current collaborative head. The first later change to body, title, or metadata atomically:

- Marks the active approval record stale.
- Records the invalidating head sequence and Principal.
- Changes readiness to `needs_review` through a system-owned transition.
- Broadcasts a bounded workflow notification.

Clients re-read workflow state after a notification. Reconnection, tab focus, and bounded periodic revalidation recover a missed notification. The SQL workflow row remains authoritative.

Archiving or otherwise removing document access closes the room with a bounded retry policy. A client may copy unsynchronized local content but cannot continue writing to the archived canonical document.

## Authentication And Workspace Isolation

The browser requests a collaboration capability from a protected Next.js endpoint. The endpoint resolves the existing Clerk Request Context and rechecks the document by Workspace, id, and active status.

The application signs a capability with an allowlisted asymmetric key and `kid`. Claims bind:

- Exact versioned room name.
- Workspace, document, Principal, and browser session.
- Read or write permission.
- Authorization epoch.
- `jti`, issuer, audience, not-before, issued-at, and expiry.

The maximum lifetime is 60 seconds. Hocuspocus verifies the algorithm, key, all claims, exact `documentName === room`, and current Workspace/document ownership. Provider token synchronization refreshes active connections. `beforeHandleMessage` rejects expired or stale authorization epochs even before the next reconnect.

Production configuration states the maximum access-revocation delay. An administrative connection-kill path may reduce it below the token lifetime later.

## Awareness And Privacy

Awareness is ephemeral and never stored. Before application or broadcast, the server replaces client-asserted identity with verified context:

- Pseudonymous Principal id suitable for the current Workspace.
- Bounded display name.
- Deterministic accessible color.
- Server-issued session id.

Email addresses, organization roles, Clerk tokens, capability tokens, and document content are forbidden. The server limits keys, string lengths, total bytes, update frequency, participants per room, and sessions per Principal. Multiple tabs remain separate sessions but group under one participant in the UI.

## Client Experience

The editor does not become writable until the initial provider sync and schema check succeed. Status differentiates:

- Connecting.
- Synchronized and durable.
- Reconnecting.
- Offline with in-tab changes waiting to merge.
- Storage delayed.
- Authorization expired.
- Read-only because access or schema changed.
- Unrecoverable synchronization error.

After a successful initial sync, an open tab may continue editing during a network interruption. Navigation and tab close warn when updates are not durably acknowledged. A failed initial connection never falls back to legacy autosave because that would create a second canonical history.

When the browser exposes the Navigation API, the client intercepts navigation attempts without rewriting browser history. Other browsers use a same-URL history sentinel. If a canceled multi-entry traversal temporarily renders another route, the recovery listener remains alive for a bounded interval, restores the exact protected URL, and keeps the durability warning active until recovery completes.

The participant UI includes accessible names, current-user labeling, a compact `+N` state, and a keyboard-readable participant list. Cursor colors meet contrast requirements.

## Compatibility And Migration

`COLLABORATION_MODE` supports `disabled` and `self-hosted`.

- Disabled mode preserves the existing revision-aware editor for documents that have not initialized collaboration.
- Self-hosted mode initializes or opens Yjs collaboration.
- Once a collaboration record exists, legacy body/title/metadata writers fail closed even if the sidecar is unavailable.
- Downgrade requires an explicit, audited export-and-reset operation and is not part of the first release.

The same-URL sentinel fallback is used only in browsers without the Navigation API. Installing that fallback with `pushState` can truncate entries that were already in the browser's forward stack. It does not weaken data safety: pending collaborative updates remain guarded, canceled backward or multi-entry traversals return to the protected document, and approved navigation still targets the browser's actual destination.

Initial migration converts one SQL snapshot to Yjs exactly once under a document-generation compare-and-set. Concurrent bootstrap attempts return the already-created generation. The original SQL snapshot stays available through normal backup history.

Schema fingerprints fence old clients. A mismatched client may open a materialized read-only view but cannot send updates. Persistent plugin schema changes require a server-owned migration that produces a new canonical update and schema version.

The Y.Doc layout and binary codec stay independent of Hocuspocus. Y-Sweet is a future S3 and horizontal-scaling candidate, but it would require new provider, authentication, server-command, and operational adapters; it is not a configuration-only replacement.

## Resource Safety

The sidecar configures limits below Hocuspocus defaults where appropriate:

- WebSocket maximum payload.
- Unauthenticated queued bytes and messages.
- Pending unauthenticated documents.
- Connections per Principal, Workspace, and room.
- Participants per room.
- Update bytes and messages per time window.
- Awareness size and frequency.
- In-memory document count and aggregate bytes.
- Candidate Tiptap nodes, nesting depth, title length, and metadata limits.

Validation applies updates to a clone before accepting them. Invalid updates close the offending connection with a stable bounded reason and never enter canonical state.

## Operations And Deployment

Hocuspocus v4 requires Node.js 22 or later. The application engine, CI, type packages, production images, and DOCX worker target move to Node.js 22 together.

Deploy the Next.js Web process and collaboration sidecar with separate environment allowlists. Only the Web process receives `COLLABORATION_CAPABILITY_SIGNING_KEY_RING`, which contains private signing JWKs. Only the sidecar receives `COLLABORATION_CAPABILITY_VERIFICATION_KEY_RING`, which contains public verification JWKs. The sidecar fails closed if non-empty private signer material is present; do not share one unrestricted environment or secret bundle between the two processes.

The sidecar exposes separate liveness and readiness endpoints. Readiness requires valid configuration and verification keys, the expected DB migration, a non-destructive storage probe, and healthy persistence/projection workers. Next.js readiness includes the sidecar check with a bounded timeout when collaboration is enabled.

Graceful shutdown follows:

```text
ready=false
  -> reject new WebSocket upgrades
  -> drain or close active connections with a retryable reason
  -> flush Hocuspocus pending stores
  -> finish update/checkpoint work
  -> close database handles
```

The deployment guide must cover WSS termination, exact origin and host allowlists, upgrade headers, disabled proxy buffering, trusted forwarded-IP handling, and an idle timeout longer than the heartbeat interval.

The first release supports one sidecar instance. SQLite/libSQL remains the starter adapter, with real two-process contention tests. Postgres is the recommended next database when concurrent write or reporting requirements outgrow that model. Redis or document sharding is considered only with a measured horizontal-scaling requirement.

## Observability

Telemetry records counts and bounded timings for:

- Connections, authentication failures, reconnects, and close reasons.
- Active rooms and participants.
- Update validation, durable append, broadcast, checkpoint, and projection latency.
- Head, checkpoint, and projected sequence lag.
- Log and checkpoint bytes.
- Storage retries and room reloads.
- Proposal target, overlap, and undo conflicts.

Telemetry excludes document text, title, metadata values, user names, email addresses, raw tokens, Yjs payloads, prompt bodies, and provider secrets.

## Test Strategy

### Unit And Contract Tests

- Capability claim validation, room tampering, expiry, epoch changes, and key rotation.
- Y.Doc bootstrap, codec round-trip, schema fingerprint, and materialization.
- Metadata key-level updates and complete candidate validation.
- Relative anchors across insertions and deletions before, inside, and after a target.
- Provider status reduction, navigation guards, and Presence normalization.
- Sequence allocation, idempotent duplicate updates, and checkpoint compaction.
- Exact forward and inverse update generation with pinned Yjs versions.

### Database And Recovery Tests

- Checkpoint plus later update replay.
- Crash after append but before live apply.
- Crash before and after checkpoint commit and log compaction.
- Corrupt checksum, generation, and schema fencing.
- Two-process SQLite contention and sequence compare-and-set retries.
- Approval invalidation and readiness transition in the update transaction.
- Action/update/Proposal/Document Change atomicity.

### Real WebSocket Tests

- Two or more clients converge after concurrent edits.
- Title and metadata synchronize without whole-object overwrites.
- Temporary disconnect edits merge after reconnect.
- Token refresh, revoked access, cross-Workspace room tampering, and read-only changes.
- Awareness identity spoofing, oversize payload, rate limits, and participant caps.
- Reconnect storms and graceful server restart.

### Proposal And Undo Tests

- AI uses an exact live snapshot rather than a lagging SQL projection.
- Pending client updates cross the synchronization barrier before AI starts.
- Stale, deleted, reversed, wrong-fragment, and wrong-generation anchors fail closed.
- Batch overlap fails before any status or content changes.
- Selective undo preserves unrelated later edits.
- Changed affected ranges return `undo_conflict`.
- Restart and Yjs garbage collection do not break a stored inverse update.

### Browser End-To-End Tests

- Two Clerk-style test Principals edit one document and observe cursors and participants.
- Body, title, and metadata converge across browser contexts.
- One context edits offline and merges after reconnect.
- AI Proposal apply and selective undo appear in every context.
- Approval automatically becomes stale and readiness becomes `needs_review` after editing.
- Reload and sidecar restart preserve state.
- Another Workspace cannot connect even with a known document id or room name.
- Initial connection failure remains read-only and never triggers legacy autosave.

## Release Gates

The implementation adds focused collaboration unit, contract, WebSocket, Docker, and Playwright commands and includes them in the repository release finish line. Production smoke starts both the Next.js artifact and sidecar against an isolated migrated database, verifies WSS/auth/readiness behavior, and guarantees bounded child-process cleanup.

Completion requires:

- Existing disabled-mode revision contracts remain green.
- All collaborative writers use the command gateway.
- No whole-snapshot collaborative undo path exists.
- Real multi-client convergence, authorization, recovery, and selective undo tests pass.
- Node.js 22 CI, production build, dependency audit, docs strict build, and Docker collaboration verification pass.
- README, Architecture, Configuration, Deployment, API Reference, Adoption, Roadmap, and Maintainer documentation describe the actual behavior and limits.

## Implementation Sequence

1. Pin Node.js 22 and add collaboration dependencies and test harnesses.
2. Add the Y.Doc codec, schema fingerprint, relative-anchor primitives, and tests.
3. Add collaboration tables, sequence fencing, update persistence, checkpointing, and recovery.
4. Add capability issuance, token synchronization, Workspace verification, and Awareness enforcement.
5. Add the Hocuspocus sidecar, Direct Connection gateway, readiness, and graceful shutdown.
6. Integrate body collaboration and scoped Yjs undo into Tiptap.
7. Integrate title, metadata, connection states, and participant UI.
8. Replace collaborative REST writers and add approval invalidation.
9. Move AI snapshots, Proposal anchors, apply, batch, and selective undo through the gateway.
10. Add Docker, production smoke, multi-user E2E, observability, and public documentation.
