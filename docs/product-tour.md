# Product Tour

Coredot Editor is organized around a three-pane writing Workspace: document context on the left, the Tiptap editor in the center, and AI review work on the right. Clerk users work in a personal owner Workspace or the currently active Clerk organization; stored resources remain scoped to that Workspace.

## Document Workspace

The center editor supports:

- Title and body editing with revision-aware persistence.
- Slash commands for blocks and AI continuation.
- Selection AI commands.
- Block gutter insertion, duplication, deletion, indentation, and drag ordering.
- Notion-style `Cmd/Ctrl+A` behavior.
- In-document find and replace with `Cmd/Ctrl+F`.
- Read-only Source mode for inspecting plain text and Tiptap JSON.
- Project Profile metadata, typed validation, readiness transitions, and localized labels.

If another tab or client saves first, stale writes return a conflict rather than overwriting the newer revision. The recovery surface preserves both versions and lets the user reload the server draft, copy the local draft, or save the local draft as a new document.

## AI Review And Rewrite

AI work is Proposal-based. The app does not directly overwrite the document after a model response.

Review flows create findings with:

- A problem statement.
- A reason.
- Exact `targetText` copied from the document.
- Drop-in `replacementText`.

Rewrite and translation flows create one Proposal for the selected text, current block, or full-document target. Users decide whether to accept, insert below, reject, or leave a Proposal pending. AI requests have bounded bodies, request budgets, a shared 30-second deadline, abort propagation, idempotent replay, and durable AI Run status; deployments can recover interrupted stale runs with `pnpm ai:recover-stale-runs`.

## Proposal Safety And Change History

Single acceptance and bulk acceptance use one server-owned document-change module. Each operation validates the submitted draft and expected revision, updates the document, records a bounded before-snapshot, and changes linked Proposal statuses in one transaction. Bulk application is all-or-nothing and creates one new document revision; a conflict leaves every Proposal pending.

The all-pending action appears only after Proposal pagination reaches its terminal page, so unloaded Proposals cannot be silently omitted. Change history is durable, and server-side undo verifies the current revision before restoring the snapshot and resetting linked Proposals atomically. It therefore survives reload and does not depend on a browser-only undo stack.

## Durable Conversations

The database Conversation adapter is the authenticated default. The list loads bounded summaries without message bodies, follows a stable opaque `(updatedAt, id)` cursor, and fetches the selected exact transcript separately. Older pages append unseen IDs instead of overwriting optimistic or already-mutated sessions.

Conversation create, message append, and fork use idempotency keys. Rename, archive, and status changes use version preconditions; after a conflict the client reloads detail to obtain the current version before retrying. Archive removes a Conversation from default lists but does not block direct detail. Conversation retention expiry hides both list and detail, while expired individual messages are omitted from a visible transcript. These rules change visibility without automatically deleting records. `CONVERSATION_STORAGE=local` is available only as an explicit single-browser demo mode.

## Prompt Templates And Project Profiles

Prompt templates are editable Workspace product configuration. Default templates cover strategy review, executive rewrite, market research critique, and contract review. Owners/admins may manage templates; members may use active templates.

Templates define:

- Name and category.
- System prompt.
- Variable schema.
- Active/default flags.

The variable schema powers both UI and server validation. A server-owned Project Profile adds typed document fields, readiness states and transitions, filters, localized labels, and stable default-template references. `PROJECT_PROFILE_ID` selects one Profile for the whole deployment; it is not a per-Workspace setting, and an unknown ID fails closed on first Profile resolution. Read [Prompting](PROMPTING.md) before replacing templates.

## DOCX Import And Export

DOCX interchange is deliberately two-phase. Import first converts the file into an unsaved preview and shows warnings plus a structured fidelity report; confirmation then creates the document idempotently. Export first previews fidelity, and actual lossy export requires explicit acknowledgement.

Each finding is classified as `preserved`, `approximated`, or `removed`. Common headings, paragraphs, lists, links, inline marks, tables, tasks, Korean text, and unknown nodes are exercised by corpus tests, but some structures are approximated or removed. Exact Word layout, comments, tracked changes, headers/footers, pagination, and embedded-media fidelity are not full-parity features.

DOCX bodies are capped at 10 MiB, document JSON at 10 MiB, Tiptap documents at 100,000 nodes and 64 levels, and conversion at 30 seconds. Conversion runs in a terminable worker so timed-out CPU work cannot persist late results.

## Plugin Layer

The build-time Editor Plugin layer has real hosts for every public contribution type:

- Tiptap extensions.
- Selection AI commands.
- Slash commands.
- Toolbar items.
- Block actions.
- Workspace panels.
- Settings sections.

Factory, handler, and render failures are isolated to the contribution and reported with its stable ID instead of crashing the editor. Browser UI plugins remain separate from the server-safe document schema profile shared by the editor, import, and export paths. Plugins are statically registered and auditable; this is not a runtime third-party plugin loader. Read [Extension Points](PLUGINS.md) before adding plugins.
