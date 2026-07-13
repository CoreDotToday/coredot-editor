# Roadmap

Coredot Editor v1 is a working open-source AI document editor starter. The roadmap below prioritizes improvements that make it more useful for repeated professional writing, review, and downstream product adoption.

## v1.1: AI Command Usability And Trust

- Maintain scope-aware quick actions in the bottom AI command bar so users can run common edits without inventing prompts.
- Extend the typed command registry with app-specific host commands, command analytics hooks, and optional AI command mode.
- Keep the live outline and `Cmd/Ctrl+F` find/replace flow stable across long Korean and mixed-language documents.
- Persist non-generic rewrite explanations when a provider returns structured `{ replacementText, explanation }` output.
- Keep plain text provider responses backward compatible.
- Show command scope and source snippets consistently in the AI workspace.

## v1.2: AI Work Context And Run Metadata

- Show command scope, selected/source snippet, provider, model, status, elapsed time, and failure reason in the AI workspace.
- Extend the database-backed conversation summaries and lazy transcript detail with search and explicit deployment-owned retention jobs after audit/legal-hold policy is defined.
- Persist prompt/context snapshots on `ai_runs` after defining storage limits and retention policy.
- Group active and completed AI work so users can keep editing without losing track of long-running requests.
- Extend the current AI context inspector with run-specific provider/model data and retrieved source snippets.

## v1.3: Inline Autocomplete

- Add an opt-in continuation suggestion at the caret.
- Keep autocomplete separate from review proposals so quick accept/reject does not pollute the proposal queue.
- Add keyboard affordances for accept, dismiss, and regenerate.
- Rate-limit autocomplete so it does not compete with explicit AI review or rewrite commands.

## v1.4: Retrieval And Citation

- Add document library ingestion for PDF, DOCX, and plain text.
- Attach source snippets, page metadata, and citation IDs to AI context.
- Feed retrieved chunks into the AI context snapshot so users can inspect exactly which external sources were sent.
- Add citation verification before showing generated citations as trusted.
- Let templates limit which source collections can be used.
- Use the Docker RAG verification stack to validate pgvector, vector-store health, and future retrieval integration tests.

## v1.5: Collaboration, Audit, And Production Controls

- Add authentication, organizations, workspaces, and ownership checks.
- Add audit logs for AI runs, accepted/rejected proposals, settings changes, and document exports.
- Add provider policy controls per workspace.
- Provide a concrete Postgres migration guide and test harness.
- Add health/readiness endpoints and production smoke checks.

## v1.6: Plugin Packs

- Render `toolbarItems` from editor plugins in the main toolbar.
- Add plugin contribution tests for active, disabled, and error states.
- Keep server-safe schema plugins separate from UI plugins.
- Package example plugins for legal review, research/citation workflows, and Korean business writing.
- Later: wire `blockActions`, `workspacePanels`, and `settingsSections`.

## Later: Document Handoff Fidelity

- Add editable Source/Markdown mode only after parser/serializer roundtrip tests cover headings, lists, tables, marks, and Korean text.
- Export Tiptap tables as real DOCX tables.
- Import DOCX tables into editable Tiptap table nodes.
- Surface DOCX import warnings before redirecting to the imported document.
- Expand markdown paste beyond pipe tables to common headings, lists, code blocks, links, and quotes.

## Later: Explainable Review And Proposal Triage

- Add proposal severity, category, confidence, and review grouping.
- Add richer stale-target recovery for repeated clauses and changed document text.
- Store document content signatures or version metadata with AI runs and proposals.
- Add “revise this proposal” and “ask why” actions.
