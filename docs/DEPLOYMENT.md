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
| `AI_PROVIDER` | Recommended | Use `stub` for demos/tests and `openai` for live AI calls. |
| `OPENAI_API_KEY` | Only with `AI_PROVIDER=openai` | Store as a secret, never in source control. |
| `OPENAI_MODEL` | Optional | Defaults through provider code when omitted. |

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
4. Run migrations against the production database.
5. Seed default templates, or create product-specific templates through the UI.

Do not use a relative local SQLite file path for production serverless deployments unless your platform explicitly provides persistent writable storage. Prefer hosted libSQL or a database service with durable storage.

## OpenAI Provider

Set:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

The provider adapter lives in `src/features/ai/providers.ts`. Provider configuration errors fail visibly instead of silently falling back to stub mode.

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
