---
status: accepted
---

# Use Yjs and Hocuspocus for real-time collaboration

Coredot Editor will use Yjs as its collaborative document merge engine and a separately deployable, self-hosted Hocuspocus v4 sidecar as its first network adapter. One Y.Doc owns the Tiptap body, title, and Project Profile metadata, while Awareness carries ephemeral presence. Readiness, approval, archive state, permissions, Proposal status, and semantic audit records remain server-authoritative.

Yjs binary checkpoints and updates become canonical for initialized collaborative content. The existing SQL document body becomes a sequence-fenced materialized read model. All collaborative server mutations pass through one command gateway so legacy autosave, AI Proposal application, and undo cannot create a second document history.

## Context

Coredot Editor already uses Tiptap and ProseMirror, persists Tiptap JSON, protects records by Clerk-derived Workspace context, applies AI Proposals through revision-checked SQL transactions, and stores whole-document before snapshots for undo. Adding a CRDT without changing those writer and undo contracts would create split-brain state and allow concurrent work to be overwritten.

The product requires rich-text collaboration, title and metadata synchronization, shared cursors, short network interruptions, self-hosting, and future deployment flexibility. It does not require browser persistence after close, peer-to-peer networking, native mobile local-first storage, or canvas/tree collaboration in the first release.

## Considered Options

- **Yjs with Hocuspocus:** selected for the existing Tiptap integration, Yjs relative positions and undo primitives, self-hosted TypeScript server, authentication hooks, Awareness hooks, persistence hooks, and Direct Connection support.
- **Yjs with Y-Sweet:** attractive for S3-compatible storage and horizontal session backends, but it would require different provider, authorization, server-command, and operations adapters. It remains a future scaling candidate rather than the first implementation.
- **Yjs with y-websocket:** smaller for a prototype but too shallow for the required Workspace authorization, durable command protocol, readiness, and operational controls.
- **Automerge:** stronger fit for long-lived offline, native, and local-first products; those requirements are explicitly out of scope.
- **Loro:** compelling for movable trees, canvases, and time-travel-heavy structured data, but it offers less leverage than the current ProseMirror/Yjs ecosystem for this editor.
- **ShareDB:** a viable central-server OT model, but adopting it would replace rather than extend the current Tiptap collaboration path and does not remove the need for semantic workflow conflicts.
- **TinyBase:** appropriate for reactive table and application state, not the primary rich-text document model.
- **WebRTC or P2P providers:** conflict with the required server Workspace authorization, durable persistence, AI commands, audit trail, and predictable operations.

## Consequences

- Hocuspocus v4 raises the supported runtime and CI baseline to Node.js 22 or later.
- The web app and stateful collaboration sidecar deploy independently.
- A collaboration capability is short-lived, room-bound, Workspace-scoped, and revalidated during an active connection.
- Client-supplied Awareness identity is replaced with server-verified identity and is never persisted.
- The body, title, and metadata are collaborative; readiness and approval are not client-writable CRDT fields.
- Editing an approved head invalidates the approval and moves readiness to `needs_review` in the same durable update transaction.
- Existing JSON documents bootstrap once. Initialized Yjs documents are never recreated from JSON during ordinary load.
- Legacy body/title/metadata autosave is disabled for initialized collaborative documents.
- AI runs bind to an exact collaborative head and Proposal targets use Yjs relative positions.
- Collaborative undo stores a tested selective inverse update. Whole-document snapshot restoration is forbidden.
- A per-document durable sequence coordinates updates, checkpoints, projections, semantic actions, and recovery across the Next.js and sidecar processes.
- SQLite/libSQL remains the starter adapter but must pass real two-process contention tests; Postgres is the expected next step when concurrency requires it.
- The application interfaces keep the Y.Doc layout portable, but changing from Hocuspocus to Y-Sweet is an adapter project rather than a configuration switch.

The complete invariants, error modes, tests, and release gates are defined in [Real-Time Collaboration Design](../realtime-collaboration.md).
