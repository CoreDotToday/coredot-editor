# Configuration

Coredot Editor keeps runtime configuration explicit. Server-side secrets live in environment variables. Non-secret AI settings can be changed in the editor UI after the database is initialized.

## Environment Variables

| Name | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/coredot.db` | SQLite/libSQL database URL. Relative `file:` paths resolve from the app root. |
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

Move to Postgres or a hosted multi-tenant database when you add:

- Organizations and workspaces.
- Row-level authorization.
- Higher write concurrency.
- Operational reporting.
- Larger collaboration workloads.

Read [Architecture](ARCHITECTURE.md#sqlite-today-postgres-later) for the migration shape.
