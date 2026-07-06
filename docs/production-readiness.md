# Production Readiness

Coredot Editor is a strong product starter, but it is not a complete hosted SaaS product. Public forks should make the following decisions before handling real users or private documents.

## Required Before Real Users

- Authentication and session management.
- Authorization for documents, templates, settings, AI runs, and proposals.
- Organizations, workspaces, or another ownership model.
- Server-side checks that every route operates only on records owned by the current user or workspace.
- Durable database deployment and backup policy.
- Production secret management for provider keys and database credentials.
- Log and trace policy that avoids storing private document text unnecessarily.
- Rate limits for AI routes and import/export endpoints.
- Operational monitoring for route errors, provider failures, and migration status.

## Database Decision

SQLite/libSQL is the default because it keeps local setup fast and makes the starter easy to understand. It can be appropriate for single-tenant internal tools and early demos.

Move to Postgres or another managed database when your fork needs:

- Multi-tenant authorization.
- Higher write concurrency.
- Advanced reporting.
- Row-level security.
- Stronger operational tooling.

Keep repository function signatures stable while migrating so route and UI code do not need broad changes.

## AI Provider Decision

The default `stub` provider is only for local development, CI, and demos. Production workflows that users expect to be model-backed should configure `coredot`, `anthropic`, `gemini`, or `openai` with server-side credentials.

Never store provider API keys in browser state, localStorage, prompt templates, screenshots, logs, or public issues.

## Document Handling

The DOCX importer/exporter preserves common structure but does not provide full Microsoft Word fidelity. Validate it against your own document corpus before depending on it for legal, financial, or regulated workflows.

## Release Gate

Run this before publishing a production fork:

```bash
pnpm release:check
pnpm docs:build
git diff --check
```

Review generated artifacts before committing. Do not commit `.env` files, local databases, Playwright traces, or generated `site/` output.
