# Coredot Editor

Open-source AI document editor starter for teams building Notion-style business writing tools.

Coredot Editor combines a Tiptap document workspace, editable prompt templates, AI-assisted review and rewrite flows, SQLite persistence, DOCX import/export, and a provider abstraction for local stub runs, Core.Today proxy routes, and direct OpenAI calls.

## Documentation

The public documentation lives in [`docs/`](docs/index.md) and is built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/).

- [Getting started](docs/getting-started.md)
- [Product tour](docs/product-tour.md)
- [Configuration](docs/configuration.md)
- [Production readiness](docs/production-readiness.md)
- [API reference](docs/api-reference.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Adopting the starter](docs/ADOPTION.md)
- [Plugins](docs/PLUGINS.md)
- [Prompting](docs/PROMPTING.md)
- [Deployment](docs/DEPLOYMENT.md)

After GitHub Pages is enabled for this repository, the hosted docs will be published from the docs workflow.

## What It Is

Coredot Editor is an application starter, not a published component package. Fork it when you want a working foundation for:

- Strategy memo and business document editors.
- Internal AI writing assistants.
- Prompt-template driven review workflows.
- Document SaaS prototypes that need persistence, tests, and a clean Next.js baseline.

The repository keeps `"private": true` in `package.json` to prevent accidental npm publication. It is still designed for open-source use through cloning, forking, and adapting the app.

## Features

- Next.js App Router workspace with document list, editor page, and template manager.
- Tiptap v3 editor with slash commands, selection commands, block gutter controls, links, task lists, and character counts.
- Static editor plugin layer for Tiptap extensions, selection AI commands, and slash menu items.
- Drizzle ORM schema with SQLite/libSQL for local persistence.
- Seeded prompt templates for strategy review, executive rewrite, market research critique, and contract review.
- AI provider adapter with deterministic `stub`, Core.Today OpenAI-compatible/Anthropic/Gemini proxy modes, and direct `openai`.
- Proposal-based review and rewrite flows with redline previews, accept/reject, bulk handling, and conservative local undo.
- Server-side proposal application transaction so accepted proposals persist document content and proposal status together.
- Document-scoped AI workspace with review, conversation, context inspector, and change-history tabs.
- DOCX import/export MVP for headings, paragraphs, lists, links, and common inline marks.
- Korean-first editor UI with English switching.
- Unit, component, route, repository, and Playwright E2E tests.

## Quick Start

Requirements:

- Node.js 20 or newer.
- pnpm 10 or newer.

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

The example environment uses `AI_PROVIDER=stub`, so AI review and rewrite flows work without an API key.

## Common Commands

```bash
pnpm dev             # Start local development server
pnpm lint            # Run ESLint
pnpm typecheck       # Run TypeScript checks
pnpm test            # Run Vitest suite
pnpm e2e             # Run Playwright E2E suite with isolated DB
pnpm build           # Build production app
pnpm check           # Run lint, typecheck, unit tests, and build
pnpm release:check   # Run local release gate including E2E and audit
pnpm docs:serve      # Serve public docs locally
pnpm docs:build      # Build public docs in strict mode
pnpm db:setup        # Run migrations and seed default templates
```

Install docs dependencies before using the docs commands:

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
```

## Production Caveats

The v1 release is intended to be a production-grade starter, not a complete hosted SaaS product. Before deploying a fork with real users:

- Add authentication, authorization, workspaces, and ownership checks.
- Choose a durable database deployment.
- Replace default prompt templates with your domain playbooks.
- Configure production model credentials through server-side environment variables.
- Validate DOCX import/export against your own document corpus.

Read [Deployment](docs/DEPLOYMENT.md) and [Adopting the starter](docs/ADOPTION.md) before shipping a fork.

## Project Structure

```text
src/app/                 Next.js routes and API route handlers
src/components/          Editor, AI workspace, settings, template UI components
src/db/                  Drizzle schema, client, migrations helper, seed data
src/features/ai/         Provider adapter, payload builder, references, run repository, workspace sessions
src/features/documents/  Document persistence, metadata/filter helpers, source snapshots, Tiptap helpers, DOCX conversion
src/features/i18n/       Editor language pack and message formatting helpers
src/features/proposals/  Proposal persistence, transactions, redline helpers
src/features/templates/  Template persistence and variable validation
src/plugins/             Static editor plugin registry and built-in plugins
scripts/e2e/             Isolated E2E database preparation
e2e/                     Playwright tests
docs/                    Public documentation source
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please do not open public issues for sensitive vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
