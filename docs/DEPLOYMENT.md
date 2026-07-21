# Deployment

This guide covers the deployment shape for Coredot Editor and the environment decisions downstream projects need to make.

## Local Production Check

```bash
pnpm install
cp .env.example .env.local
export AUTH_MODE=clerk
export CLERK_SECRET_KEY=sk_test_ci_build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
pnpm db:setup
pnpm build
pnpm start
```

Open [http://localhost:3000](http://localhost:3000).

Those fixed values are non-secret test-format configuration for local build/start verification only; they do not authenticate users. Replace them with real Clerk keys from the deployment secret manager for any deployed instance.

## Required Environment Variables

| Name | Required | Notes |
| --- | --- | --- |
| `AUTH_MODE` | Yes | Use `clerk` in production. `test` is rejected when `NODE_ENV=production`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key for the deployed instance. |
| `CLERK_SECRET_KEY` | Yes | Clerk server secret. Store it only in the deployment secret manager. |
| `DATABASE_URL` | Yes in deployed environments | Use a writable SQLite/libSQL URL. Relative `file:` paths are mainly for local development. |
| `DATABASE_AUTH_TOKEN` | With authenticated hosted libSQL | Canonical database token used by both the runtime client and Drizzle migrations. |
| `TURSO_AUTH_TOKEN` | Optional compatibility fallback | Used only when `DATABASE_AUTH_TOKEN` is blank; the canonical variable wins. |
| `AI_PROVIDER` | Optional but recommended | Initial provider seed before `app_settings` exists. A valid explicit value wins; otherwise `COREDOT_API_KEY` selects `coredot`, then `OPENAI_API_KEY` selects `openai`, and otherwise the seed is `stub`. |
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
| `COLLABORATION_MODE` | Optional | `disabled` (default) or `self-hosted`. Self-hosted mode additionally requires the collaboration variables described in [Configuration](configuration.md#environment-variables) and the sidecar deployment below. |

Production startup fails before the server becomes ready if Clerk keys are missing or `AUTH_MODE=test`. Keep test-auth variables such as `TEST_PRINCIPAL_ID` and `TEST_WORKSPACE_ID` out of production. The test-format keys used by `pnpm e2e:production` are isolated smoke credentials, not deployment credentials.

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

For hosted libSQL, configure one credential pair for both commands and the running app:

```bash
DATABASE_URL=libsql://YOUR_DATABASE_HOST
DATABASE_AUTH_TOKEN=YOUR_SECRET_TOKEN
pnpm db:migrate
```

Local `file:` URLs need no auth token. Relative file paths resolve from the application root. Hosted tokens are trimmed, whitespace-only values are ignored, and `TURSO_AUTH_TOKEN` is supported only as a fallback for existing deployments.

Migration `0007_request_budgets` adds the durable request-budget table and expiry index. Before applying it in production, stop writers or use your provider's maintenance window and take a verified database backup. Apply the migration, then confirm `PRAGMA foreign_key_check` is empty. Restoring the pre-migration backup is the rollback path; do not try to hand-edit migration journal state.

## Recovering Interrupted AI Runs

Migration `0012_ai_run_attempt_token` adds the execution-attempt token used to fence late workers and the `(status, updated_at)` recovery index. Apply migrations before enabling recovery. Existing rows receive a null token and cannot be finalized by an invented token; stale active legacy rows are released by the same recovery procedure as current rows.

Run recovery from one or more schedulers every five minutes:

```bash
pnpm ai:recover-stale-runs
```

The default command marks only `pending` or `streaming` runs with no update for 15 minutes as `failed` with `operation_interrupted`. It clears retry leases and execution tokens so the idempotent operation can be claimed again with a fresh token. The update is atomic, safe to run concurrently, and idempotent. Output contains only `status` and the aggregate `recoveredCount`; failures emit only a generic failed status.

The stale window must be 1 to 10,080 minutes and the command timeout must be 100 to 60,000 milliseconds:

```bash
pnpm ai:recover-stale-runs -- --stale-after-minutes=30 --timeout-ms=10000
```

Choose a stale window longer than the maximum expected AI operation time and scheduler clock skew. Alert on a failed command or a sustained nonzero recovery count. Do not log database URLs, auth tokens, run IDs, payloads, or raw command errors from the scheduler.

## Health And Readiness Probes

The two public operational endpoints intentionally expose only generic state and are never cached:

- `GET /api/health` returns `200 {"status":"ok"}` when the process can serve requests. It does not access the database.
- `GET /api/ready` returns `200 {"status":"ready"}` only when a bounded database query succeeds and the latest `ai_runs.execution_token` schema marker exists.
- Database errors, missing migrations, timeouts, and cancelled checks all return `503 {"status":"unavailable"}` without driver errors, URLs, tokens, or SQL details.
- `HEAD` preserves the corresponding status with an empty body. `OPTIONS` returns `204` and `Allow: GET, HEAD, OPTIONS`.

Run migrations before adding an instance to service. Configure the platform liveness probe to `/api/health` and the traffic/readiness probe to `/api/ready`. A failing readiness probe should remove the instance from traffic; it should not trigger migration or recovery automatically.

## Real-Time Collaboration Sidecar

Real-time collaboration is optional. `COLLABORATION_MODE=disabled` (the default) keeps the existing revision-aware editor and requires none of this section. `COLLABORATION_MODE=self-hosted` adds a second deployable process: the Hocuspocus sidecar built by `pnpm collaboration:build`. Both processes require Node.js 22.13+; the engine pin, CI, production images, and DOCX worker all target Node 22 together.

Deploy the Web process and the sidecar with separate environment allowlists as described in [Configuration](configuration.md#collaboration-capability-keys): only the Web process receives the private signing key ring, and only the sidecar receives the public verification key ring. The sidecar refuses to start when private signing material is present in its environment. Key generation and rotation steps, and the 60-second maximum access-revocation delay, are documented there as well.

### Sidecar health probes

The sidecar exposes its own uncached probes on its HTTP listener:

- `GET /live` returns `200 {"status":"live"}` while the process can serve requests.
- `GET /ready` returns `200 {"status":"ready"}` only when configuration and verification keys are valid, the expected collaboration migrations exist, a non-destructive storage probe succeeds, and the room-closure, workflow-notification, and command-delivery reconcilers are healthy. Readiness returns `503` during drain and after migration, key, or database failures.

Run database migrations before the sidecar can become ready. Point the platform liveness probe at `/live` and the traffic probe at `/ready`. `SIGTERM` starts a bounded graceful drain: readiness goes down, new upgrades are rejected, connections close with a retryable reason, pending durable work finishes, a checkpoint is written, and database handles close within `COLLABORATION_SHUTDOWN_GRACE_MS`.

### WSS termination and proxy limits

Browsers connect to `COLLABORATION_WEBSOCKET_URL` over WSS in production. The proxy or load balancer in front of the sidecar must:

- Terminate TLS and forward WebSocket upgrades (`Upgrade`/`Connection` headers preserved).
- Forward the exact browser `Origin` and the routed `Host`; both are checked against `COLLABORATION_ALLOWED_ORIGINS` and `COLLABORATION_ALLOWED_HOSTS`, and mismatches are rejected before authentication.
- Disable response buffering for the WebSocket path.
- Use trusted forwarded-IP handling only at the boundary you control.
- Configure an idle timeout longer than the WebSocket heartbeat interval so healthy connections are not recycled.

### Single-sidecar SQLite constraint

This release supports exactly one sidecar instance per database. SQLite/libSQL is the starter adapter with real two-process (Web + sidecar) contention coverage, but the sidecar itself must not be scaled horizontally: there is no Redis fan-out or shared-document coordination between multiple sidecars. Scale the Web process freely; scale collaboration by moving to Postgres and a horizontal adapter when measured requirements demand it (see the [Roadmap](ROADMAP.md)).

### Backup and recovery

Canonical collaborative state lives in the same database as everything else: `collaboration_documents` holds checkpoints and `collaboration_updates` holds the append-only update log. Existing database backups therefore cover collaboration; no separate artifact store exists in this release. Recovery loads the latest checkpoint and replays newer updates in order. A checksum, generation, or schema mismatch fails readiness and requires explicit repair - the sidecar never silently rebuilds Yjs state from the SQL projection, because that would create a second canonical history. Restoring a backup rolls the whole document set to one consistent point in time; open tabs reconnect and reload the restored canonical state.

### Docker

`Dockerfile.collaboration` builds the sidecar into a Node 22 image that applies migrations to the mounted database volume before starting the server, and `docker-compose.collaboration.yml` runs it with an isolated named volume and a `/ready` healthcheck. `pnpm docker:collaboration:verify` builds the image, waits for readiness, verifies `/live` and `/ready`, stops the container with `SIGTERM`, and requires a clean exit code before tearing everything down.

## Claiming Legacy Local Data

Migration `0006` assigns pre-workspace rows to the reserved `local` workspace. After configuring the real authenticated workspace, preview the transfer:

```bash
pnpm db:claim-local-workspace -- --workspace=clerk:org:YOUR_ORG_ID --dry-run
```

Back up the database, stop application writers, and then claim it:

```bash
pnpm db:claim-local-workspace -- --workspace=clerk:org:YOUR_ORG_ID
```

The command trims and validates the target, refuses `local`, and reports counts for the complete workspace-owned graph. That graph includes documents and templates, request budgets, AI runs/proposals/conversations/messages, document change history, settings, and all collaboration documents, updates, actions, approval records, authorization epochs, anchors, change mappings, and AI-run snapshots. It moves only rows whose `workspace_id` is `local`.

Before moving anything, the command checks built-in template keys, document creation keys, AI idempotency keys, conversation creation keys, request-budget identities, collaboration authorization epochs, and singleton settings for collisions in the target workspace. It never merges colliding records. All updates run in one transaction with deferred foreign keys, followed by a database-wide foreign-key check before commit; a conflict or failed check rolls back the entire graph without partial movement. Run all database migrations before claiming so the current collaboration tables participate in the transfer.

The claim is intentionally one-way: after a successful commit, use the database backup to roll back. Do not rerun it with another target expecting already-claimed rows to move; a second run is a no-op because it only selects `local` rows.

## API Capacity and Failure Semantics

Request budgets and resource limits are code-owned defaults documented in [Configuration](configuration.md#request-budgets). All app instances must use the same policy values and the same durable database.

- `429 Request rate limit exceeded`: the workspace/principal/policy bucket is exhausted. Honor `Retry-After`; the `X-RateLimit-*` headers describe the boundary.
- `503 Request rate limit temporarily unavailable`: SQLite remained busy or locked after the bounded admission retry. The request was rejected before downstream work; honor `Retry-After` and investigate sustained database write contention.
- `413 Document exceeds resource limits`: reject the file/document or reduce its DOCX size, complete parsed JSON size, depth, or node count before retrying.
- `504 Operation timed out`: import, export, or AI work crossed the 30-second operation deadline. Provider-capable calls receive an abort signal; timed-out import/export work does not continue to persistence.

Monitor these statuses separately from application `5xx` errors. `OPTIONS` requests authenticate through the existing protected seam but do not consume request budget.

## Runtime LLM Settings

The app stores non-secret model settings in the `app_settings` table and exposes them through the editor header's `LLM 설정` dialog. The dialog can switch between `stub`, `coredot`, `anthropic`, `gemini`, and `openai`, set model names, set Core.Today Base URL and max completion tokens, choose reasoning effort where supported, and run a connection test. Connection tests require a workspace owner/admin, consume the dedicated 5-per-minute durable request budget before workspace bootstrap or provider access, and abort after 30 seconds.

API keys remain server-side environment variables. The settings API returns only boolean secret status such as whether `COREDOT_API_KEY` is configured; it never returns or accepts API key values from the browser.

Core.Today Base URL settings are pinned to the official routes for each provider:

- `coredot`: `https://api.core.today/llm/openai/v1`
- `anthropic`: `https://api.core.today/llm/anthropic/v1`
- `gemini`: `https://api.core.today/llm/gemini/v1beta`

The app rejects browser-supplied hosts, explicit ports, credentials, query strings, fragments, and cross-provider paths before using `COREDOT_API_KEY`. If an older database row contains an unsafe Core.Today URL, the runtime settings layer sanitizes it back to the provider default instead of returning it unchanged.

## Vercel Notes

The app can be deployed to Vercel as a standard Next.js app.

Before deploying:

1. Configure `AUTH_MODE=clerk`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`.
2. Configure `DATABASE_URL` and `DATABASE_AUTH_TOKEN` for hosted libSQL.
3. Configure `AI_PROVIDER` for the initial settings seed.
4. Configure `OPENAI_API_KEY` if using OpenAI.
5. Configure `COREDOT_API_KEY` if using any Core.Today provider.
6. Run migrations against the production database and confirm `/api/ready` succeeds.
7. Seed default templates, or create product-specific templates through the UI.

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
AUTH_MODE=test
DATABASE_URL=file:./data/e2e/coredot-e2e.db
TEST_PRINCIPAL_ID=e2e-user
TEST_WORKSPACE_ID=e2e-workspace
pnpm exec next dev -p ${E2E_PORT:-3100}
```

Playwright is configured with `reuseExistingServer: false` so tests do not accidentally attach to a server using production-like credentials.

If port `3100` is already used by another local process, run `E2E_PORT=3200 pnpm e2e`.

Stop any manually running `pnpm dev` process before running `pnpm e2e`. Next.js allows only one dev server for the same project directory, even when the E2E server uses a different port.

`pnpm e2e:production` is the production-artifact gate. It uses `AUTH_MODE=clerk` with non-secret test-format Clerk credentials and a deterministic sign-in route, inherits only a minimal OS/tool environment, creates and migrates an isolated temporary database, builds the app, starts `pnpm start` on a dynamic loopback port, waits for `/api/ready`, and verifies health/readiness methods, the root redirect, the protected-page Clerk redirect, and the unauthenticated protected-API `401` contract. Every phase and response body is bounded; the server process tree, port, database, and SQLite sidecars are independently cleaned on success or failure.

CI runs lint, typecheck, unit/component tests, development E2E, build, production smoke, security audit, and the strict documentation build. To reproduce the documentation gate locally, install `requirements-docs.txt` in a virtual environment and run `pnpm docs:build` with that environment active.

## Deployment Checklist

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm e2e` passes.
- [ ] `pnpm e2e:production` passes.
- [ ] `pnpm collaboration:production-smoke` passes when collaboration will be enabled.
- [ ] `pnpm docker:collaboration:verify` passes when the sidecar ships as a container.
- [ ] `pnpm build` passes.
- [ ] `pnpm docs:build` passes in the documentation virtual environment.
- [ ] `pnpm security:audit` passes.
- [ ] Production Clerk mode and both Clerk keys are configured; test auth is absent.
- [ ] Production `DATABASE_URL` is configured.
- [ ] Hosted `DATABASE_AUTH_TOKEN` is stored in the secret manager and works for both migrations and runtime access.
- [ ] AI provider secrets are configured.
- [ ] Migrations have run.
- [ ] `/api/health` and `/api/ready` probes use their distinct liveness/readiness roles.
- [ ] With collaboration enabled: separate signing/verification key allowlists, sidecar `/live` and `/ready` probes, WSS proxy upgrade/buffering/idle-timeout settings, and exactly one sidecar instance per database.
- [ ] Interrupted-AI recovery is scheduled, bounded, and monitored without sensitive output.
- [ ] A pre-migration backup has been verified and `PRAGMA foreign_key_check` is empty after migration.
- [ ] Legacy `local` data has been dry-run and claimed when upgrading an existing deployment.
- [ ] All app instances share the same request-budget database and policy constants.
- [ ] Default or product-specific templates exist.
- [ ] Logs are monitored for AI provider failures and route errors.

The security audit uses npm's public bulk advisory endpoint without credentials. It blocks moderate-or-higher advisories and treats lockfile, transport, HTTP, or response-validation errors as release failures.
