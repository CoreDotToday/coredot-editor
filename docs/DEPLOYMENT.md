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
| `AI_PROVIDER` | Recommended | Use `stub` for demos/tests, `coredot` for Core.Today proxy calls, and `openai` for direct OpenAI calls. |
| `OPENAI_API_KEY` | Only with `AI_PROVIDER=openai` | Store as a secret, never in source control. |
| `OPENAI_MODEL` | Optional | Defaults through provider code when omitted. |
| `COREDOT_API_KEY` | Only with `AI_PROVIDER=coredot` | Store as a secret, never in source control. |
| `COREDOT_MODEL` | Optional | Defaults to `gpt-5-nano`. |
| `COREDOT_BASE_URL` | Optional | Defaults to `https://api.core.today/llm/openai/v1`. |
| `COREDOT_MAX_COMPLETION_TOKENS` | Optional | Defaults to provider behavior when omitted. |

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

## Vercel Notes

The app can be deployed to Vercel as a standard Next.js app.

Before deploying:

1. Configure `DATABASE_URL`.
2. Configure `AI_PROVIDER`.
3. Configure `OPENAI_API_KEY` if using OpenAI.
4. Configure `COREDOT_API_KEY` if using Core.Today.
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
COREDOT_MAX_COMPLETION_TOKENS=32768
```

Core.Today's OpenAI-compatible route lets the app keep the same Vercel AI SDK provider contract while routing requests through `https://api.core.today/llm/openai/v1`.

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
pnpm exec next dev -p 3100
```

Playwright is configured with `reuseExistingServer: false` so tests do not accidentally attach to a server using production-like credentials.

Stop any manually running `pnpm dev` process before running `pnpm e2e`. Next.js allows only one dev server for the same project directory, even when the E2E server uses a different port.

## Deployment Checklist

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm e2e` passes.
- [ ] `pnpm build` passes.
- [ ] Production `DATABASE_URL` is configured.
- [ ] AI provider secrets are configured.
- [ ] Migrations have run.
- [ ] Default or product-specific templates exist.
- [ ] Logs are monitored for AI provider failures and route errors.
