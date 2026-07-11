# Deployment

This guide covers the deployment shape for Coredot Editor and the environment decisions downstream projects need to make.

## Local Production Check

```bash
pnpm install
cp .env.example .env.local
pnpm db:setup
pnpm build
pnpm start
```

Open [http://localhost:3000](http://localhost:3000).

## Required Environment Variables

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes in deployed environments | Use a writable SQLite/libSQL URL. Relative `file:` paths are mainly for local development. |
| `AI_PROVIDER` | Recommended | Initial provider seed before `app_settings` exists. Use `stub` for demos/tests, `coredot`, `anthropic`, or `gemini` for Core.Today proxy calls, and `openai` for direct OpenAI calls. |
| `OPENAI_API_KEY` | Only with `AI_PROVIDER=openai` | Store as a secret, never in source control. |
| `OPENAI_MODEL` | Optional | Initial OpenAI model seed when omitted from saved settings. |
| `COREDOT_API_KEY` | With Core.Today providers | Required for `coredot`, `anthropic`, and `gemini`. Store as a secret, never in source control. |
| `COREDOT_MODEL` | Optional | Initial Core.Today model seed. Defaults to `gpt-5-nano`. |
| `COREDOT_BASE_URL` | Optional | Initial Core.Today Base URL seed. Defaults to `https://api.core.today/llm/openai/v1`. |
| `COREDOT_ANTHROPIC_MODEL` | Optional | Initial Core.Today Anthropic model seed. Defaults to `claude-sonnet-4.5`. |
| `COREDOT_ANTHROPIC_BASE_URL` | Optional | Initial Core.Today Anthropic Base URL seed. Defaults to `https://api.core.today/llm/anthropic/v1`. |
| `COREDOT_GEMINI_MODEL` | Optional | Initial Core.Today Gemini model seed. Defaults to `gemini-2.5-flash`. |
| `COREDOT_GEMINI_BASE_URL` | Optional | Initial Core.Today Gemini Base URL seed. Defaults to `https://api.core.today/llm/gemini/v1beta`. |
| `COREDOT_MAX_COMPLETION_TOKENS` | Optional | Initial Core.Today output token seed. Defaults to `32768`. |

## Database Setup

For local development:

```bash
pnpm db:setup
```

For deployed environments:

```bash
pnpm db:migrate
pnpm db:seed
```

Run migrations before starting the app. The seed script is idempotent for default prompt templates.

Migration `0007_request_budgets` adds the durable request-budget table and expiry index. Before applying it in production, stop writers or use your provider's maintenance window and take a verified database backup. Apply the migration, then confirm `PRAGMA foreign_key_check` is empty. Restoring the pre-migration backup is the rollback path; do not try to hand-edit migration journal state.

## Claiming Legacy Local Data

Migration `0006` assigns pre-workspace rows to the reserved `local` workspace. After configuring the real authenticated workspace, preview the transfer:

```bash
pnpm db:claim-local-workspace -- --workspace=clerk:org:YOUR_ORG_ID --dry-run
```

Back up the database, stop application writers, and then claim it:

```bash
pnpm db:claim-local-workspace -- --workspace=clerk:org:YOUR_ORG_ID
```

The command trims and validates the target, refuses `local`, reports counts for documents, templates, AI runs, proposals, and settings, and moves only rows whose `workspace_id` is `local`. It preflights built-in-template and settings conflicts, performs all updates in one transaction, and verifies foreign keys before commit. A conflict or failed check rolls the transaction back without partial movement.

The claim is intentionally one-way: after a successful commit, use the database backup to roll back. Do not rerun it with another target expecting already-claimed rows to move; a second run is a no-op because it only selects `local` rows.

## API Capacity and Failure Semantics

Request budgets and resource limits are code-owned defaults documented in [Configuration](configuration.md#request-budgets). All app instances must use the same policy values and the same durable database.

- `429 Request rate limit exceeded`: the workspace/principal/policy bucket is exhausted. Honor `Retry-After`; the `X-RateLimit-*` headers describe the boundary.
- `413 Document exceeds resource limits`: reject the file/document or reduce its byte size, depth, or node count before retrying.
- `504 Operation timed out`: import, export, or AI work crossed the 30-second operation deadline. Provider-capable calls receive an abort signal; timed-out import/export work does not continue to persistence.

Monitor these statuses separately from application `5xx` errors. `OPTIONS` requests authenticate through the existing protected seam but do not consume request budget.

## Runtime LLM Settings

The app stores non-secret model settings in the `app_settings` table and exposes them through the editor header's `LLM 설정` dialog. The dialog can switch between `stub`, `coredot`, `anthropic`, `gemini`, and `openai`, set model names, set Core.Today Base URL and max completion tokens, choose reasoning effort where supported, and run a connection test.

API keys remain server-side environment variables. The settings API returns only boolean secret status such as whether `COREDOT_API_KEY` is configured; it never returns or accepts API key values from the browser.

Core.Today Base URL settings are pinned to the official routes for each provider:

- `coredot`: `https://api.core.today/llm/openai/v1`
- `anthropic`: `https://api.core.today/llm/anthropic/v1`
- `gemini`: `https://api.core.today/llm/gemini/v1beta`

The app rejects browser-supplied hosts, explicit ports, credentials, query strings, fragments, and cross-provider paths before using `COREDOT_API_KEY`. If an older database row contains an unsafe Core.Today URL, the runtime settings layer sanitizes it back to the provider default instead of returning it unchanged.

## Vercel Notes

The app can be deployed to Vercel as a standard Next.js app.

Before deploying:

1. Configure `DATABASE_URL`.
2. Configure `AI_PROVIDER` for the initial settings seed.
3. Configure `OPENAI_API_KEY` if using OpenAI.
4. Configure `COREDOT_API_KEY` if using any Core.Today provider.
5. Run migrations against the production database.
6. Seed default templates, or create product-specific templates through the UI.

Do not use a relative local SQLite file path for production serverless deployments unless your platform explicitly provides persistent writable storage. Prefer hosted libSQL or a database service with durable storage.

## OpenAI Provider

Set:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

The provider adapter lives in `src/features/ai/providers.ts`. Provider configuration errors fail visibly instead of silently falling back to stub mode.

## Core.Today LLM Proxy Provider

Set:

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

Core.Today's proxy routes let the app keep one server-side `COREDOT_API_KEY` while routing OpenAI-compatible requests through `https://api.core.today/llm/openai/v1`, Anthropic messages through `https://api.core.today/llm/anthropic/v1`, and Gemini generateContent requests through `https://api.core.today/llm/gemini/v1beta`.

For GPT-5 style models, configure `max_completion_tokens` through `COREDOT_MAX_COMPLETION_TOKENS` for the initial seed or through `LLM 설정` after deployment. Reasoning effort is saved in `app_settings` and passed through the OpenAI-compatible provider options.

Do not commit real Core.Today keys. Rotate a key if it appears in public logs, screenshots, issues, or chat transcripts.

## Stub Provider

Set:

```bash
AI_PROVIDER=stub
```

Stub mode is useful for:

- Local development
- E2E tests
- Demos without model credentials
- CI

Do not use stub mode for production workflows that users expect to be model-backed.

## E2E Environment

`pnpm e2e` prepares an isolated database and starts its own Playwright server with:

```bash
AI_PROVIDER=stub
DATABASE_URL=file:./data/e2e/coredot-e2e.db
pnpm exec next dev -p ${E2E_PORT:-3100}
```

Playwright is configured with `reuseExistingServer: false` so tests do not accidentally attach to a server using production-like credentials.

If port `3100` is already used by another local process, run `E2E_PORT=3200 pnpm e2e`.

Stop any manually running `pnpm dev` process before running `pnpm e2e`. Next.js allows only one dev server for the same project directory, even when the E2E server uses a different port.

## Deployment Checklist

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm e2e` passes.
- [ ] `pnpm build` passes.
- [ ] `pnpm security:audit` passes.
- [ ] Production `DATABASE_URL` is configured.
- [ ] AI provider secrets are configured.
- [ ] Migrations have run.
- [ ] A pre-migration backup has been verified and `PRAGMA foreign_key_check` is empty after migration.
- [ ] Legacy `local` data has been dry-run and claimed when upgrading an existing deployment.
- [ ] All app instances share the same request-budget database and policy constants.
- [ ] Default or product-specific templates exist.
- [ ] Logs are monitored for AI provider failures and route errors.
