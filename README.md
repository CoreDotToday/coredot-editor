# Coredot Editor

Open-source AI document editor starter for teams building Notion-style business writing tools.

Coredot Editor combines a Tiptap document workspace, editable prompt templates, AI-assisted review and rewrite flows, SQLite persistence, and a provider abstraction that can run locally with a deterministic stub, through Core.Today's OpenAI/Anthropic/Gemini LLM proxy routes, or directly with OpenAI through the Vercel AI SDK.

## What It Is

Coredot Editor is an application starter, not a published component package. Fork it when you want a working foundation for:

- Strategy memo and business document editors
- Internal AI writing assistants
- Prompt-template driven review workflows
- Document SaaS prototypes that need persistence, tests, and a clean Next.js baseline

The repository keeps `"private": true` in `package.json` to prevent accidental npm publication. It is still designed for open-source use through cloning, forking, and adapting the app.

## Release Status

Current release: `1.0.0`.

The v1 release is intended to be a production-grade starter, not a complete hosted SaaS product. It includes the editor shell, AI proposal workflow, prompt templates, provider abstraction, persistence layer, DOCX import/export MVP, plugin extension points, and release checks needed for downstream teams to build from.

Before deploying a fork with real users, make the product-specific decisions that this starter intentionally leaves open:

- Add authentication, authorization, workspaces, and ownership checks.
- Choose a durable database deployment. SQLite/libSQL is the default; Postgres migration is a good next step for larger multi-tenant products.
- Replace default prompt templates with your domain playbooks and review standards.
- Configure production model credentials through server-side environment variables.
- Validate DOCX import/export against your own document corpus before relying on it for high-fidelity Word workflows.

## Features

- Next.js App Router workspace with document list, editor page, and template manager
- Tiptap v3 editor with title editing, slash commands, selection commands, block gutter controls, placeholder text, link support, task lists, typography, drop/gap cursor behavior, and character counts
- Static editor plugin layer for adding Tiptap extensions, selection AI commands, and slash menu items without editing the central editor components
- Notion-style `Cmd/Ctrl+A` behavior inside the editor: first selects the current block, second selects the whole document
- Drizzle ORM schema with SQLite/libSQL for local persistence
- Seeded, source-informed prompt templates for strategy review, executive rewrite, market research critique, and contract review
- Contract review playbook template for risk-focused clause review and redline-ready replacement suggestions
- Editable prompt template manager with JSON variable schema validation
- AI provider adapter with local `stub`, Core.Today `coredot`, Core.Today `anthropic`, Core.Today `gemini`, and direct `openai` modes
- Review API that creates proposal records from structured AI findings
- Rewrite API for exact-match selected text proposals, translations, and continue-writing insertions
- SuperDoc-style bottom AI command bar for natural-language edits against the current selection, current block, or whole document
- Right-side AI workspace with review, document-scoped AI conversation sessions, hideable chats, and change-history tabs
- Typed command registry and command palette for workspace actions, opened with `Cmd/Ctrl+K` or the editor header's more menu
- Read-only Source mode for inspecting, copying, and downloading the current unsaved draft as plain text and Tiptap JSON
- Inline pending proposal highlights inspired by Tiptap Content AI suggestions
- Redline-style proposal previews with inserted/deleted text labels for contract review workflows
- DOCX import/export MVP for core document structure: headings, paragraphs, lists, links, and common inline marks
- "Show in document" proposal focus so reviewers can jump from the review panel to the source text
- Bulk accept and reject controls for AI review proposals
- Local undo for accepted AI applications when no newer editor changes would be overwritten
- AI run history and persisted proposal accept/reject status
- Korean LLM settings dialog for provider, model, Base URL, max completion tokens, reasoning effort, and connection testing
- Lightweight editor language pack with Korean default and English UI switching
- Isolated Playwright E2E database so tests do not mutate local development data
- Unit, component, route, repository, and E2E tests

## Tech Stack

- Next.js 16, React 19, TypeScript
- Tiptap 3
- Tailwind CSS 4
- Drizzle ORM with SQLite/libSQL
- Vercel AI SDK and `@ai-sdk/openai`
- Zod
- Vitest, Testing Library, Playwright
- pnpm

## Quick Start

Requirements:

- Node.js 20 or newer
- pnpm 10 or newer

Install dependencies:

```bash
pnpm install
```

Create local environment settings:

```bash
cp .env.example .env.local
```

Prepare the local development database:

```bash
pnpm db:setup
```

Run the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

With the example environment, the first saved LLM setting uses `stub`, so the AI flows work without an API key. If `AI_PROVIDER=coredot` or a Core.Today key is already configured, the first settings row is initialized for Core.Today instead. After that, the in-app `LLM 설정` dialog controls provider/model settings from the database.

In the editor, use the bottom `무엇을 변경할까요?` command bar for freeform AI requests. The command targets selected text first, then the current block, then the full document. AI output is saved as a proposal instead of immediately overwriting text; review it in the right workspace's `검토`, `대화`, and `변경내역` tabs.

Open the command palette with `Cmd/Ctrl+K` or the header's more menu to jump between AI workspace actions, review, save/export, and Source mode. Commands are built from a typed registry with groups, enabled states, shortcuts, and fuzzy search. The `Source` tab is read-only and reflects the current in-memory draft, including unsaved edits, as extracted plain text plus Tiptap JSON; use its copy and download actions when debugging provider prompts or document conversion.

Type `/` in the editor to open the slash command menu. The menu supports core Tiptap block commands such as text, headings, bullet/numbered/task lists, quote, divider, code block, and AI continue writing. Use the left-side block gutter controls for quick block insertion, duplication, deletion, and drag reordering.

Use `DOCX 가져오기` on the document list to create a new document from a `.docx` file. Use `DOCX 내보내기` in the editor header to export the current in-memory draft, including unsaved edits. DOCX conversion is intentionally an MVP: it preserves core editing structure and text semantics, not exact Word layout, comments, tracked changes, headers, footers, or embedded media fidelity.

## Editor Architecture

Coredot Editor uses Tiptap as the document engine and keeps product behavior in focused layers:

- `DocumentEditor` composes the editor surface, toolbar, AI command bar, proposal highlights, and block controls.
- `DocumentShell` owns host-level workspace state such as Source mode, saving/exporting, and AI workspace visibility.
- `DocumentCommandPalette` renders the host command registry with grouped fuzzy search, shortcut labels, and keyboard navigation.
- `DocumentSourceView` renders the current draft as plain text and Tiptap JSON with copy/download affordances.
- `AiWorkspacePanel` renders review proposals, per-command AI conversation sessions, and accepted-change history. Chat sessions are persisted per document through a local adapter that can be replaced by database-backed conversation/message tables.
- `editor-block-ranges.ts` resolves the current paragraph, heading, or list item into a normalized block target and owns pointer hit-testing helpers used by the gutter.
- `editor-block-drop-targets.ts` classifies drag destinations and suppresses invalid or no-op drops before a document mutation can happen.
- `editor-block-drag-session.ts` guards drag operations against stale live editor state.
- `tiptap-blocks.ts` applies pure JSON transforms for top-level blocks and nested list items.
- The plugin registry contributes Tiptap extensions, slash commands, AI selection commands, and future editor actions.

AI changes are proposal-based by default. Selection commands preserve a target snapshot so stale edits can be detected before applying a replacement or insert-below action.

## Core.Today LLM Proxy Setup

Core.Today exposes LLM proxy routes for OpenAI, Anthropic, and Gemini. The OpenAI-compatible base URL is `https://api.core.today/llm/openai/v1`; Anthropic uses `https://api.core.today/llm/anthropic/v1`; Gemini uses `https://api.core.today/llm/gemini/v1beta`.

Set these values in `.env.local`:

```bash
AI_PROVIDER=coredot
COREDOT_API_KEY=your_core_today_api_key
COREDOT_MODEL=gpt-5-nano
COREDOT_BASE_URL=https://api.core.today/llm/openai/v1
COREDOT_ANTHROPIC_MODEL=claude-sonnet-4.5
COREDOT_ANTHROPIC_BASE_URL=https://api.core.today/llm/anthropic/v1
COREDOT_GEMINI_MODEL=gemini-2.5-flash
COREDOT_GEMINI_BASE_URL=https://api.core.today/llm/gemini/v1beta
COREDOT_MAX_COMPLETION_TOKENS=32768
```

Then open the editor and use `LLM 설정` to choose the provider, model, Base URL, max completion tokens, and reasoning effort where supported. Use `연결 테스트` to verify the server-side key and current model settings. API keys stay in environment variables and are never sent to the browser.

Core.Today Base URL settings are allowlisted to the official provider routes only. Browser or database settings cannot redirect the server-side `COREDOT_API_KEY` to arbitrary hosts, ports, query strings, fragments, credentials, or a different Core.Today provider path.

Do not commit real API keys. If a key is exposed in a chat, issue, log, or screenshot, rotate it in the Core.Today console.

## Direct OpenAI Setup

Set these values in `.env.local` when you want live model calls:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

The provider integrations are isolated in `src/features/ai/providers.ts`. Add other providers there without changing the editor UI or route contracts.

## Common Commands

```bash
pnpm dev          # Start local development server
pnpm build        # Build production app
pnpm start        # Start production build
pnpm lint         # Run ESLint
pnpm typecheck    # Run TypeScript checks
pnpm test         # Run Vitest suite
pnpm e2e          # Run Playwright E2E suite with isolated DB
pnpm check        # Run lint, typecheck, unit tests, and build
pnpm security:audit # Run dependency audit at moderate severity and above
pnpm release:check  # Run full local release gate, including E2E and audit
pnpm docker:rag:up     # Start local Postgres/pgvector and ChromaDB services
pnpm docker:rag:verify # Verify the local RAG Docker services
pnpm docker:rag:down   # Stop the local RAG Docker services
pnpm db:setup     # Run migrations and seed default templates
pnpm db:generate  # Generate a Drizzle migration from schema changes
pnpm db:migrate   # Apply Drizzle migrations
pnpm db:seed      # Seed default prompt templates
```

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/coredot.db` | SQLite/libSQL database URL. Relative `file:` paths are resolved from the app root. |
| `AI_PROVIDER` | `stub` | Initial provider seed when `app_settings` has not been created yet. Supported values: `stub`, `coredot`, `anthropic`, `gemini`, `openai`. The in-app LLM settings take precedence afterward. |
| `OPENAI_API_KEY` | empty | Required only when `AI_PROVIDER=openai`. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Initial model seed for the OpenAI provider. |
| `COREDOT_API_KEY` | empty | Required for Core.Today `coredot`, `anthropic`, and `gemini` provider modes. |
| `COREDOT_MODEL` | `gpt-5-nano` | Initial model seed for Core.Today. |
| `COREDOT_BASE_URL` | `https://api.core.today/llm/openai/v1` | Initial OpenAI-compatible Core.Today base URL. |
| `COREDOT_ANTHROPIC_MODEL` | `claude-sonnet-4.5` | Initial Anthropic model seed for Core.Today. |
| `COREDOT_ANTHROPIC_BASE_URL` | `https://api.core.today/llm/anthropic/v1` | Initial Core.Today Anthropic base URL. |
| `COREDOT_GEMINI_MODEL` | `gemini-2.5-flash` | Initial Gemini model seed for Core.Today. |
| `COREDOT_GEMINI_BASE_URL` | `https://api.core.today/llm/gemini/v1beta` | Initial Core.Today Gemini base URL. |
| `COREDOT_MAX_COMPLETION_TOKENS` | `32768` | Initial maximum output tokens for Core.Today proxy calls. |

## Project Structure

```text
src/app/                 Next.js routes and API route handlers
src/components/          Editor, AI workspace, settings, template UI components
src/db/                  Drizzle schema, client, migrations helper, seed data
src/features/ai/         Provider adapter, payload builder, AI run repository, AI workspace session store
src/features/documents/  Document persistence, source snapshots, Tiptap helpers, DOCX conversion
src/features/i18n/       Editor language pack and message formatting helpers
src/features/proposals/  Proposal persistence, transactions, redline helpers
src/features/templates/  Template persistence and variable validation
src/plugins/             Static editor plugin registry and built-in plugins
scripts/e2e/             Isolated E2E database preparation
e2e/                     Playwright tests
docs/                    Public maintainer and adopter documentation
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and extension points. Read [docs/PLUGINS.md](docs/PLUGINS.md) before adding editor plugins. Read [docs/PROMPTING.md](docs/PROMPTING.md) before replacing prompt templates.

For RAG, citation, and Postgres migration experiments, use [docs/RAG_DOCKER.md](docs/RAG_DOCKER.md). It runs Postgres/pgvector and ChromaDB in Docker while the Next.js app remains local.

Read [docs/ROADMAP.md](docs/ROADMAP.md) for the recommended post-v1 build order.

## Using This In Another Project

Start with [docs/ADOPTION.md](docs/ADOPTION.md). The short version:

1. Fork or clone the repository.
2. Rename the product and package metadata.
3. Replace or extend the seeded prompt templates in `src/db/seed.ts`, keeping the contracts in [docs/PROMPTING.md](docs/PROMPTING.md).
4. Add project-specific editor behavior through `src/plugins/app-plugins.ts`, following [docs/PLUGINS.md](docs/PLUGINS.md).
5. Keep the AI provider contract stable while adding your model provider.
6. Decide whether to stay on SQLite/libSQL or migrate the Drizzle layer.
7. Run `pnpm check` and `pnpm e2e` before shipping your fork.

## Testing Notes

`pnpm e2e` uses `data/e2e/coredot-e2e.db`, recreates it before each run, and starts Playwright with:

```bash
AI_PROVIDER=stub
DATABASE_URL=file:./data/e2e/coredot-e2e.db
pnpm exec next dev -p 3100
```

This keeps E2E tests deterministic and prevents test documents from polluting the development database.

Stop any manually running `pnpm dev` process before `pnpm e2e`; Next.js allows only one dev server for the same project directory.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for local, Vercel, database, and provider setup notes.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please do not open public issues for sensitive vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
