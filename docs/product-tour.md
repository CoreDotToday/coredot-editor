# Product Tour

Coredot Editor is organized around a three-pane writing workspace: document context on the left, the Tiptap editor in the center, and AI review work on the right.

## Document Workspace

The center editor supports:

- Title and body editing.
- Slash commands for blocks and AI continuation.
- Selection AI commands.
- Block gutter insertion, duplication, deletion, indentation, and drag ordering.
- Notion-style `Cmd/Ctrl+A` behavior.
- In-document find and replace with `Cmd/Ctrl+F`.
- Read-only Source mode for inspecting plain text and Tiptap JSON.

## AI Review And Rewrite

AI work is proposal-based. The app does not directly overwrite the document after a model response.

Review flows create findings with:

- A problem statement.
- A reason.
- Exact `targetText` copied from the document.
- Drop-in `replacementText`.

Rewrite and translation flows create a single proposal for the selected text, current block, or full document target. Users decide whether to accept, insert below, reject, or leave a proposal pending.

## Proposal Safety

Proposal acceptance uses `/api/proposals/:id/apply`. The route receives the last known saved document content signature, applies the proposal to the saved server document, updates document content, and marks the proposal accepted in one transaction.

This prevents a common failure mode where a proposal status is accepted while the saved document still contains the old text.

## Prompt Templates

Prompt templates are editable product configuration. Default templates cover strategy review, executive rewrite, market research critique, and contract review.

Templates define:

- Name and category.
- System prompt.
- Variable schema.
- Active/default flags.

The variable schema powers both the UI and server-side route validation. Read [Prompting](PROMPTING.md) before replacing templates.

## DOCX Import And Export

DOCX support is an MVP for common business document structure:

- Headings.
- Paragraphs.
- Lists.
- Links.
- Common inline marks.

It does not preserve exact Word layout, comments, tracked changes, headers, footers, embedded media fidelity, or table fidelity yet. Treat it as a starting point for product-specific conversion work.

## Plugin Layer

The static editor plugin layer lets downstream projects add:

- Tiptap extensions.
- Selection AI commands.
- Slash menu commands.

Reserved contribution types are already part of the public interface for future toolbar items, block actions, workspace panels, and settings sections. Read [Extension Points](PLUGINS.md) before adding plugins.
