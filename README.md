# Coredot Editor

Open-source AI document editor starter for teams building Notion-style business writing tools.

Coredot Editor combines a Tiptap document workspace, editable prompt templates, AI-assisted review and rewrite flows, SQLite persistence, and a provider abstraction that can run locally with a deterministic stub, through Core.Today's OpenAI-compatible LLM proxy, or directly with OpenAI through the Vercel AI SDK.

## What It Is

Coredot Editor is an application starter, not a published component package. Fork it when you want a working foundation for:

- Strategy memo and business document editors
- Internal AI writing assistants
- Prompt-template driven review workflows
- Document SaaS prototypes that need persistence, tests, and a clean Next.js baseline

The repository keeps `"private": true` in `package.json` to prevent accidental npm publication. It is still designed for open-source use through cloning, forking, and adapting the app.

## Features

- Next.js App Router workspace with document list, editor page, and template manager
- Tiptap v3 editor with title editing, selection commands, placeholder text, link support, task lists, typography, and character counts
- Drizzle ORM schema with SQLite/libSQL for local persistence
- Seeded prompt templates for strategy review, executive rewrite, and market research critique
- Editable prompt template manager with JSON variable schema validation
- AI provider adapter with local `stub`, Core.Today `coredot`, and direct `openai` modes
- Review API that creates proposal records from structured AI findings
- Rewrite API for exact-match selected text proposals
- AI run history and persisted proposal accept/reject status
- Lightweight editor language pack with English default and Korean UI switching
- Isolated Playwright E2E database so tests do not mutate local development data
- Unit, component, route, repository, and E2E coverage

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

By default, the app uses `AI_PROVIDER=stub`, so the AI flows work without an API key.

## Core.Today LLM Proxy Setup

Core.Today exposes an OpenAI-compatible LLM base URL at `https://api.core.today/llm/openai/v1`.

Set these values in `.env.local`:

```bash
AI_PROVIDER=coredot
COREDOT_API_KEY=your_core_today_api_key
COREDOT_MODEL=gpt-5-nano
COREDOT_BASE_URL=https://api.core.today/llm/openai/v1
COREDOT_MAX_COMPLETION_TOKENS=32768
```

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
pnpm db:setup     # Run migrations and seed default templates
pnpm db:generate  # Generate a Drizzle migration from schema changes
pnpm db:migrate   # Apply Drizzle migrations
pnpm db:seed      # Seed default prompt templates
```

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/coredot.db` | SQLite/libSQL database URL. Relative `file:` paths are resolved from the app root. |
| `AI_PROVIDER` | `stub` | `stub` for deterministic local output, `coredot` for Core.Today proxy calls, `openai` for direct OpenAI calls. |
| `OPENAI_API_KEY` | empty | Required only when `AI_PROVIDER=openai`. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Model used by the OpenAI provider. |
| `COREDOT_API_KEY` | empty | Required only when `AI_PROVIDER=coredot`. |
| `COREDOT_MODEL` | `gpt-5-nano` | Model name sent to the Core.Today OpenAI-compatible endpoint. |
| `COREDOT_BASE_URL` | `https://api.core.today/llm/openai/v1` | OpenAI-compatible Core.Today base URL. |
| `COREDOT_MAX_COMPLETION_TOKENS` | `32768` | Maximum output tokens for Core.Today proxy calls. |

## Project Structure

```text
src/app/                 Next.js routes and API route handlers
src/components/          Editor, AI panel, template UI components
src/db/                  Drizzle schema, client, database URL helper, seed data
src/features/ai/         Provider adapter, payload builder, AI run repository
src/features/documents/  Document persistence and Tiptap text extraction
src/features/i18n/       Editor language pack and message formatting helpers
src/features/proposals/  Proposal persistence and exact-match apply logic
src/features/templates/  Template persistence and variable validation
scripts/e2e/             Isolated E2E database preparation
e2e/                     Playwright tests
docs/                    Public maintainer and adopter documentation
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and extension points.

## Using This In Another Project

Start with [docs/ADOPTION.md](docs/ADOPTION.md). The short version:

1. Fork or clone the repository.
2. Rename the product and package metadata.
3. Replace or extend the seeded prompt templates in `src/db/seed.ts`.
4. Keep the AI provider contract stable while adding your model provider.
5. Decide whether to stay on SQLite/libSQL or migrate the Drizzle layer.
6. Run `pnpm check` and `pnpm e2e` before shipping your fork.

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
