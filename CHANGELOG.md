# Changelog

All notable changes to Coredot Editor will be documented here.

This project uses a simple human-written changelog. Keep entries concise and grouped by release.

## Unreleased

### Added

- Added scope-aware quick action presets to the bottom AI command bar.
- Added a public roadmap for post-v1 AI editor improvements.

### Changed

- Selection rewrite prompts now prefer structured `{ replacementText, explanation }` output while preserving plain text fallback behavior.
- Rewrite proposals now persist model-provided explanations when available.

## 1.0.0 - 2026-06-07

First v1 release of Coredot Editor as an open-source AI document editor starter.

### Added

- Korean-first editor UI with English language switching.
- Core.Today LLM proxy support for OpenAI-compatible, Anthropic, and Gemini routes.
- LLM settings dialog for provider, model, Base URL, token limit, reasoning effort, and connection checks.
- Right-side AI workspace with review, conversation, and change-history tabs.
- Bottom AI command bar for selection, current-block, and whole-document edits.
- Proposal workflow with pending, accept, reject, bulk actions, document focus, redline preview, and local undo.
- Contract review template and prompt guidance for structured legal-style findings.
- DOCX import and export MVP for headings, paragraphs, lists, links, and inline marks.
- Static editor plugin layer with documented extension points for Tiptap extensions, slash commands, and selection AI commands.
- Slash command menu, block gutter controls, drag indicators, block insertion, duplication, deletion, indentation, outdent, and list-to-paragraph conversion flows.
- Notion-style `Cmd/Ctrl+A` behavior for current block then whole document.
- Markdown paste support for common block structures including pipe tables.
- Responsive layout tests for narrow editor viewports.

### Changed

- Reworked selected-text AI from an obstructive floating menu into persistent proposal and command workflows.
- Improved nested list and mixed block drag-and-drop behavior with visible drop indicators and caret preservation.
- Hardened Core.Today Base URL handling so browser/database settings cannot redirect server-side API keys.
- Expanded unit, component, route, repository, and Playwright E2E coverage for v1 user flows.

### Security

- Kept API keys server-side only; settings APIs expose secret presence booleans, not secret values.
- Added dependency audit to CI and the local `release:check` gate.

## 0.1.0 - 2026-05-09

Initial open-source starter release.

### Added

- Next.js App Router application scaffold
- Tiptap document workspace with title editing and document body editing
- SQLite/libSQL persistence through Drizzle ORM
- Document list, create, update, archive, and editor pages
- Seeded prompt templates for strategy review, executive rewrite, and market research critique
- Prompt template manager with create, update, archive, active-only listing, and variable schema validation
- AI provider abstraction with deterministic stub provider and OpenAI provider path
- AI rewrite and review API routes
- AI run repository and proposal repository
- Proposal status persistence
- AI review panel, prompt template panel, and run history panel
- Unit, component, route, repository, and Playwright E2E tests
- Isolated E2E database preparation
- Open-source project documentation and repository policy files

### Changed

- Added Core.Today OpenAI-compatible LLM proxy provider mode.
- Improved selected-text AI actions with a floating contextual toolbar.
- Wired selection rewrite commands to the AI rewrite API and proposal panel.
