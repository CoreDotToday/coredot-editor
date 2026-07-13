# Coredot Editor

Open-source AI document editor starter for teams building Notion-style business writing tools.

Coredot Editor combines a Tiptap document workspace, Clerk-backed personal and organization Workspaces, editable prompt templates, AI-assisted review and rewrite flows, durable Conversations, SQLite/libSQL persistence, and fidelity-aware DOCX interchange. Its provider abstraction supports deterministic stub runs, Core.Today proxy routes, and direct OpenAI calls.

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
- Build-time editor plugin layer with hosts for Tiptap extensions, selection and slash commands, toolbar items, block actions, workspace panels, and settings sections.
- Clerk request context with personal/organization Workspaces, owner/admin/member roles, and repository-level Workspace predicates.
- Drizzle ORM schema with SQLite/libSQL persistence and revision-aware document writes.
- Seeded prompt templates for strategy review, executive rewrite, market research critique, and contract review.
- AI provider adapter with deterministic `stub`, Core.Today OpenAI-compatible/Anthropic/Gemini proxy modes, and direct `openai`.
- Proposal-based review and rewrite flows with redline previews, accept/reject, atomic single/bulk apply, durable change history, and server-side undo.
- Revision conflict recovery that preserves both local and server drafts instead of silently overwriting either one.
- Bounded AI execution with abort propagation, idempotent replay, attempt fencing, structured telemetry, and a stale-run recovery command.
- Document-scoped AI workspace with review, conversation, context inspector, and change-history tabs.
- Database-backed Conversations with cursor-paged summaries, lazy transcript detail, idempotent mutations, version conflicts, archive state, and explicit retention metadata.
- Code-defined Project Profiles for reusable metadata, readiness transitions, list filters, labels, and default templates.
- Cursor-paged document, AI run, proposal, and conversation collections with lazy transcript/proposal detail loading.
- Shared accessible modal behavior for settings, command palette, interchange confirmation, and compact drawers.
- DOCX import/export with bounded worker conversion and structured preserved/approximated/removed fidelity reports; lossy export requires acknowledgement.
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
It also uses `AUTH_MODE=test`, which creates one deterministic owner identity and Workspace for local development and automated tests. This adapter is not a production authentication mode.

`pnpm build`, `pnpm check`, and `pnpm release:check` create a production build and intentionally fail without production-style Clerk configuration. For local or CI verification only, export the fixed non-secret test-format values below before running those commands:

```bash
export AUTH_MODE=clerk
export CLERK_SECRET_KEY=sk_test_ci_build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
```

These values satisfy the configuration preflight only; they do not authenticate users. Use real Clerk keys from your secret manager for any deployed instance.

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
pnpm e2e:production  # Build/start the production artifact and run bounded smoke checks
pnpm docs:serve      # Serve public docs locally
pnpm docs:build      # Build public docs in strict mode
pnpm db:setup        # Run migrations and seed default templates
pnpm ai:recover-stale-runs # Mark interrupted stale AI attempts recoverable
```

Install docs dependencies before using the docs commands:

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
```

## Production Deployment

The release is a production-grade starter, not a complete hosted SaaS product. A production deployment must use `AUTH_MODE=clerk` with `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; startup fails before readiness when Clerk is missing or test authentication is selected. Clerk organizations map to shared Workspaces, while signed-in users without an active organization receive a personal owner Workspace.

Before serving private documents, also choose a durable database and backup policy, run migrations, configure server-side model credentials, select one server-owned `PROJECT_PROFILE_ID` for the deployment, schedule and monitor stale AI Run recovery, and validate DOCX fidelity against your own corpus. Conversation retention timestamps affect visibility but do not run automatic deletion; a deployment that deletes data must define its own audit, backup, legal-hold, and linked-record policy.

Run the complete verification sequence before release:

```bash
pnpm release:check
pnpm e2e:production
.venv-docs/bin/python -m mkdocs build --strict
git diff --check
```

`release:check` runs lint, typecheck, unit/component tests, development E2E, production-auth startup checks, the production build, and the dependency audit at the configured moderate-or-higher threshold. The separate production smoke starts the built artifact with an isolated migrated database and verifies health, readiness, redirects, and protected-route behavior.

Read [Deployment](docs/DEPLOYMENT.md) and [Adopting the starter](docs/ADOPTION.md) before shipping a fork.

## Project Structure

```text
src/app/                 Next.js routes and API route handlers
src/components/          Editor, AI workspace, settings, template UI components
src/db/                  Drizzle schema, client, migrations helper, seed data
src/features/ai/         Provider execution, AI runs, durable Conversations, references, and recovery
src/features/auth/       Clerk/test request adapters, Workspace roles, and protected route/page context
src/features/documents/  Document persistence, metadata/filter helpers, source snapshots, Tiptap helpers, DOCX conversion
src/features/i18n/       Editor language pack and message formatting helpers
src/features/proposals/  Proposal persistence, transactions, redline helpers
src/features/projects/   Server-owned Project Profile definitions and validation
src/features/security/   Durable request budgets and resource policies
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
