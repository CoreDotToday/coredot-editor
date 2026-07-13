# Roadmap

Coredot Editor now has the production-oriented foundation needed for downstream products: Clerk-backed Workspaces, revision-safe changes, bounded AI execution, real plugin hosts, fidelity-aware DOCX interchange, durable Conversations, and server-owned Project Profiles. The roadmap focuses on capabilities that are not part of that baseline.

## AI Workflow And Retrieval

- Add richer AI Run metadata, grouping, and user-facing failure diagnostics without exposing prompt bodies or secrets in logs.
- Add Conversation search across bounded summary metadata.
- Persist inspectable prompt and context snapshots after storage limits and retention policy are defined.
- Add opt-in inline autocomplete with independent rate limits and accept/dismiss/regenerate shortcuts.
- Add document-library retrieval for PDF, DOCX, and plain text, with inspectable source snippets, citation IDs, and citation verification.

## Collaboration, Audit, And Operations

- Add real-time multi-user editing with a defined CRDT or equivalent synchronization model. Revision conflicts remain the current cross-client safety mechanism.
- Expand the existing Document Change and AI Run records into a granular audit trail for settings changes, exports, authentication events, and administrative actions.
- Add provider policy controls per Workspace.
- Provide a concrete Postgres migration guide, concurrency harness, and production observability runbook.
- Add explicit retention deletion jobs only after policy, audit, legal-hold, backup, and foreign-key requirements are settled; the current release does not delete records automatically.

## Plugin Packs And Project Profiles

- Package example plugins for legal review, research and citation, and Korean business writing.
- Define schema migration contracts for downstream plugins that add persistent document nodes.
- Consider optional per-Workspace Project Profile administration after authorization, migration, and compatibility semantics are designed. The current Profile remains one server-owned selection per deployment.

## Full Word Fidelity

- Round-trip Tiptap tables as real DOCX tables, including nested and merged structures.
- Add explicit support for comments, tracked changes, headers, footers, embedded media, pagination, and layout-sensitive features.
- Grow the DOCX corpus and diff tooling across Korean and mixed-language business documents.
- Pursue full Word parity as separate product work; the current structured fidelity report makes preservation, approximation, and removal visible but does not claim parity.

## Explainable Review And Proposal Triage

- Add Proposal severity, category, confidence, and review grouping.
- Add richer stale-target recovery for repeated clauses and substantially changed document text.
- Store bounded content signatures or version metadata with AI Runs and Proposals where they improve explanation and recovery.
- Add “revise this Proposal” and “ask why” actions.
