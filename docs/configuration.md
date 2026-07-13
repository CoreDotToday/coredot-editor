# Configuration

Coredot Editor keeps runtime configuration explicit. Server-side secrets live in environment variables. Non-secret AI settings can be changed in the editor UI after the database is initialized.

## Environment Variables

| Name | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/coredot.db` | SQLite/libSQL database URL. Relative `file:` paths resolve from the app root. |
| `DATABASE_AUTH_TOKEN` | empty | Canonical hosted libSQL authentication token used by both the runtime and migrations. |
| `TURSO_AUTH_TOKEN` | empty | Compatibility fallback when `DATABASE_AUTH_TOKEN` is blank. The canonical variable wins when both are set. |
| `AUTH_MODE` | Clerk unless exactly `test` | Authentication adapter. `test` is deterministic local/test identity only and is rejected in production. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | empty | Required Clerk publishable key for production. |
| `CLERK_SECRET_KEY` | empty | Required server-side Clerk secret key for production. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` | Public Clerk sign-in route. |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` | Public Clerk sign-up route. |
| `TEST_PRINCIPAL_ID` | `test:principal:local` | Deterministic Principal used only by `AUTH_MODE=test`. |
| `TEST_WORKSPACE_ID` | `test:workspace:local` | Deterministic owner Workspace used only by `AUTH_MODE=test`. |
| `AI_PROVIDER` | derived | Initial provider seed before `app_settings` exists: an explicit valid value wins, otherwise `COREDOT_API_KEY` selects `coredot`, then `OPENAI_API_KEY` selects `openai`, and otherwise the app uses `stub`. |
| `OPENAI_API_KEY` | empty | Required for direct OpenAI calls. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Initial direct OpenAI model. |
| `COREDOT_API_KEY` | empty | Required for Core.Today OpenAI-compatible, Anthropic, and Gemini provider modes. |
| `COREDOT_MODEL` | `gpt-5-nano` | Initial Core.Today OpenAI-compatible model. |
| `COREDOT_BASE_URL` | `https://api.core.today/llm/openai/v1` | Initial Core.Today OpenAI-compatible Base URL. |
| `COREDOT_ANTHROPIC_MODEL` | `claude-sonnet-4.5` | Initial Anthropic model through Core.Today. |
| `COREDOT_ANTHROPIC_BASE_URL` | `https://api.core.today/llm/anthropic/v1` | Initial Core.Today Anthropic Base URL. |
| `COREDOT_GEMINI_MODEL` | `gemini-2.5-flash` | Initial Gemini model through Core.Today. |
| `COREDOT_GEMINI_BASE_URL` | `https://api.core.today/llm/gemini/v1beta` | Initial Core.Today Gemini Base URL. |
| `COREDOT_MAX_COMPLETION_TOKENS` | `32768` | Initial maximum output tokens for Core.Today proxy calls. |
| `PROJECT_PROFILE_ID` | `default` | Server-owned code-defined Project Profile. Valid built-ins are `default`, `legal-review`, and `research-writing`; an unknown value fails closed when the active Profile is first resolved instead of falling back. |
| `CONVERSATION_STORAGE` | `database` | Conversation adapter. Use `database` for authenticated durable workspaces; `local` is an explicit browser-only demo mode. Unknown values fail closed. |

The runtime defaults to Clerk whenever `AUTH_MODE` is not exactly `test`. The checked-in `.env.example` intentionally sets `AUTH_MODE=test` so a fresh local checkout works without Clerk credentials.

## Authentication And Workspaces

Production must set `AUTH_MODE=clerk`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`. The production start command validates this before launching Next.js; it rejects missing/blank Clerk credentials and rejects `AUTH_MODE=test`. The deterministic test adapter always returns its configured test Principal as owner of its configured test Workspace. It is intended for local development, automated tests, and isolated demos, not hosted authentication.

An active Clerk organization maps to `clerk:org:<organization-id>`. A signed-in user without an active organization maps to the personal owner Workspace `clerk:user:<user-id>`. Clerk organization roles normalize to `owner`, `admin`, or `member`. Repositories include Workspace predicates on resource reads and writes, and cross-Workspace identifiers resolve as not found.

Members may work with documents, DOCX interchange, AI Runs, Proposals, Document Changes, and Conversations. Only owners/admins may mutate prompt templates and AI settings or test saved provider credentials. `PROJECT_PROFILE_ID` remains deployment-owned rather than a Workspace setting.

## Project Profiles

`PROJECT_PROFILE_ID` is resolved only on the server and applies consistently to every workspace served by that deployment. It is not a per-workspace administrative setting. A Profile defines metadata fields and field types, readiness states and allowed transitions, filterable fields, localized labels, and stable built-in template references. The same Profile drives document creation/update validation, proposal application, metadata controls, list filters, readiness badges, and default-template selection.

Profile definitions must have a non-empty stable ID, localized name, at least one readiness state beginning with `draft`, unique field/state/template identifiers, valid transition targets, and options only for `select` fields. Select values, booleans, finite numbers, calendar dates, tags, text length, and readiness transitions are validated before persistence. Required metadata may be omitted while the target readiness is `draft`, but every required field must be present before leaving `draft`; returning to `draft` allows the document to become incomplete again. Existing unknown metadata keys are preserved only when unchanged so a Profile deployment does not silently destroy legacy data.

## Conversation Storage And Retention

Database Conversation lists return bounded metadata summaries and load the selected transcript through a separate Workspace-scoped detail route. Archive removes a Conversation from default lists, while `includeArchived=true` lists it and its direct detail route remains readable. An expired Conversation retention timestamp hides both summary and detail; an expired individual message is omitted from an otherwise visible transcript. Expiration changes visibility only—the application does not destructively prune records. `CONVERSATION_STORAGE=local` keeps the same store interface for an explicit single-browser demo, but it is not durable across browsers. Deployments that add deletion must first define audit, pending-operation, backup, legal-hold, and foreign-key behavior.

## AI Providers

Supported provider modes:

- `stub`: deterministic local provider for development, tests, demos, and CI.
- `coredot`: Core.Today OpenAI-compatible proxy.
- `anthropic`: Core.Today Anthropic messages proxy.
- `gemini`: Core.Today Gemini generateContent proxy.
- `openai`: direct OpenAI provider through the Vercel AI SDK.

The editor header's `LLM settings` dialog stores non-secret provider settings in the database. API keys stay in server environment variables and are never returned to the browser.

## AI Execution And Recovery

Review and rewrite requests share one 30-second deadline across bounded body reading, preflight, provider work, and finalization. The request signal and deadline abort provider work where supported. Requests use idempotency keys and execution-attempt tokens so exact completed retries can replay safely while late timed-out attempts cannot finalize newer work.

Schedule the stale-run recovery command for deployments that run AI traffic:

```bash
pnpm ai:recover-stale-runs
```

It marks pending/streaming attempts older than 15 minutes as interrupted by default and has a 10-second command timeout. Both are bounded overrides:

```bash
pnpm ai:recover-stale-runs -- --stale-after-minutes=30 --timeout-ms=20000
```

The command is safe to rerun and emits only a generic status/count, but deployments still need to choose a scheduler, alerting, and frequency appropriate to their workload.

## Core.Today URL Safety

Core.Today Base URLs are allowlisted to official provider routes. Browser or database settings cannot redirect `COREDOT_API_KEY` to arbitrary hosts, ports, credentials, query strings, fragments, or another Core.Today provider path.

## Database

The default database is SQLite/libSQL. It is suitable for local development, demos, modest authenticated Workspaces, single-tenant internal tools, and early product forks.

Local `file:` URLs need no authentication token. Hosted libSQL deployments should set `DATABASE_URL` and `DATABASE_AUTH_TOKEN`; the runtime client and Drizzle migrations resolve the same URL/token pair. Tokens are trimmed, whitespace-only values are ignored, and the optional `authToken` property is omitted when no token is configured.

Move to Postgres or a hosted multi-tenant database when you add:

- Higher write concurrency.
- Operational reporting.
- Larger collaboration workloads.
- Database-native row-level security or stricter isolation requirements.

Read [Architecture](ARCHITECTURE.md#sqlite-today-postgres-later) for the migration shape.

## Request Budgets

Selected mutation and AI endpoints use durable, fixed-window budgets stored in SQLite/libSQL. A bucket is scoped by workspace, authenticated principal, policy, and epoch-aligned window start, so one user or workspace cannot consume another bucket. Restarts and multiple app processes share the same database state.

The defaults are intentionally code-owned rather than environment-controlled. Change `REQUEST_BUDGET_POLICIES` in `src/features/security/request-budget.ts`, review capacity, and deploy the same values to every app instance:

| Policy | Limit | Window |
| --- | ---: | ---: |
| AI provider connection test | 5 | 60 seconds |
| AI review | 20 | 60 seconds |
| AI rewrite | 20 | 60 seconds |
| Conversation fork | 20 | 60 seconds |
| Conversation mutation | 120 | 60 seconds |
| Document create | 30 | 60 seconds |
| DOCX export preview | 20 | 60 seconds |
| DOCX export | 20 | 60 seconds |
| DOCX import | 10 | 60 seconds |

The limit includes the last allowed request. The next request receives `429` until the exclusive next fixed-window boundary. The response includes `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Budget consumption happens after authentication but before workspace bootstrap, so an exhausted first request cannot create default templates or settings. CORS/authentication `OPTIONS` requests are not budgeted. The atomic consume is retried with bounded backoff for SQLite `BUSY`/`LOCKED` contention; exhaustion fails closed with `503` and `Retry-After`. Retention runs only after a successful consume, is best effort, and keeps expired buckets for a five-minute clock-skew grace period. This prevents a moderately ahead application instance from deleting a bucket that a behind instance could otherwise recreate for extra allowance.

## Resource Policies

The server enforces these code-owned limits in `src/features/security/resource-policy.ts`:

| Resource | Limit |
| --- | ---: |
| DOCX input | 10 MiB |
| Parsed document JSON | 10 MiB |
| Tiptap node depth and JSON container depth | 64 levels |
| Tiptap document count | 100,000 nodes |
| Import, export, or AI operation | 30 seconds |
| Document title | 500 characters |

`Content-Length` is only an early rejection hint: JSON and multipart request streams are always counted while being read, and the reader is cancelled immediately at the byte boundary even when the header is missing or falsely small. Bodyless or pre-parsed multipart adapters are rejected rather than bypassing the bounded stream reader. Imports cap the complete multipart envelope before parsing, then check `File.size` before `File.arrayBuffer()`. Converted imports and submitted documents are traversed iteratively before persistence or DOCX conversion. Content arrays and enumerable object properties are scheduled lazily, with only the current child value retained on the traversal stack. Structural Tiptap node objects and their `content` arrays use the 64-level node-depth boundary; non-structural objects and arrays such as attrs and marks start an independent 64-level general container-depth boundary at each node. Content arrays are also rejected against the remaining node budget before their children are visited. The traversal counts the complete JSON representation—including text, marks, attributes, property names, separators, and scalar values—without allocating a second full serialized copy. DOCX conversion runs in a terminable Node worker, so the 30-second main-thread deadline can stop CPU-bound conversion and prevent late persistence or output. Oversized or overly deep documents return `413`; timed-out conversion/provider work, including provider connection tests, returns `504`. Existing AI context schemas continue to bound commands, variables, selections, references, and submitted document text.

## Production Verification

Run the complete release sequence from the application root:

`pnpm build`, `pnpm check`, and `pnpm release:check` create a production build, which intentionally fails when production Clerk configuration is absent. For local or CI verification only, load these fixed, non-secret test-format values before running those commands:

```bash
export AUTH_MODE=clerk
export CLERK_SECRET_KEY=sk_test_ci_build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
```

These values satisfy configuration validation only; they do not authenticate users and must not be used for a deployed instance. A real deployment requires real Clerk keys from its secret manager.

```bash
pnpm release:check
pnpm e2e:production
.venv-docs/bin/python -m mkdocs build --strict
git diff --check
```

`release:check` runs lint, TypeScript checks, the Vitest suite, development Playwright E2E, production-auth startup validation, the production build, and `pnpm audit --audit-level moderate`. The audit therefore blocks findings at the configured moderate-or-higher threshold; it is not a claim that every package has zero findings at every severity setting.

`e2e:production` creates and migrates an isolated temporary database, builds the app, starts the built artifact through `pnpm start` with Clerk mode and test-format smoke credentials, and verifies bounded health/readiness responses, public redirects, protected-page redirects, and protected API rejection. Cleanup is bounded even after failures. The strict MkDocs build and `git diff --check` finish documentation and patch hygiene verification.
