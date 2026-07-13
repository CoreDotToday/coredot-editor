# Configuration

Coredot Editor keeps runtime configuration explicit. Server-side secrets live in environment variables. Non-secret AI settings can be changed in the editor UI after the database is initialized.

## Environment Variables

| Name | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/coredot.db` | SQLite/libSQL database URL. Relative `file:` paths resolve from the app root. |
| `DATABASE_AUTH_TOKEN` | empty | Canonical hosted libSQL authentication token used by both the runtime and migrations. |
| `TURSO_AUTH_TOKEN` | empty | Compatibility fallback when `DATABASE_AUTH_TOKEN` is blank. The canonical variable wins when both are set. |
| `AI_PROVIDER` | `stub` | Initial provider seed before `app_settings` exists. |
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

## AI Providers

Supported provider modes:

- `stub`: deterministic local provider for development, tests, demos, and CI.
- `coredot`: Core.Today OpenAI-compatible proxy.
- `anthropic`: Core.Today Anthropic messages proxy.
- `gemini`: Core.Today Gemini generateContent proxy.
- `openai`: direct OpenAI provider through the Vercel AI SDK.

The editor header's `LLM settings` dialog stores non-secret provider settings in the database. API keys stay in server environment variables and are never returned to the browser.

## Core.Today URL Safety

Core.Today Base URLs are allowlisted to official provider routes. Browser or database settings cannot redirect `COREDOT_API_KEY` to arbitrary hosts, ports, credentials, query strings, fragments, or another Core.Today provider path.

## Database

The default database is SQLite/libSQL. It is suitable for local development, demos, single-tenant internal tools, and early product forks.

Local `file:` URLs need no authentication token. Hosted libSQL deployments should set `DATABASE_URL` and `DATABASE_AUTH_TOKEN`; the runtime client and Drizzle migrations resolve the same URL/token pair. Tokens are trimmed, whitespace-only values are ignored, and the optional `authToken` property is omitted when no token is configured.

Move to Postgres or a hosted multi-tenant database when you add:

- Organizations and workspaces.
- Row-level authorization.
- Higher write concurrency.
- Operational reporting.
- Larger collaboration workloads.

Read [Architecture](ARCHITECTURE.md#sqlite-today-postgres-later) for the migration shape.

## Request Budgets

Mutation and AI endpoints use durable, fixed-window budgets stored in SQLite/libSQL. A bucket is scoped by workspace, authenticated principal, policy, and epoch-aligned window start, so one user or workspace cannot consume another bucket. Restarts and multiple app processes share the same database state.

The defaults are intentionally code-owned rather than environment-controlled. Change `REQUEST_BUDGET_POLICIES` in `src/features/security/request-budget.ts`, review capacity, and deploy the same values to every app instance:

| Policy | Limit | Window |
| --- | ---: | ---: |
| AI provider connection test | 5 | 60 seconds |
| AI review | 20 | 60 seconds |
| AI rewrite | 20 | 60 seconds |
| Document create | 30 | 60 seconds |
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
