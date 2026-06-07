# Adopting Coredot Editor In Another Product

Use this guide when forking Coredot Editor into a new product or internal tool.

## Recommended Adoption Path

1. Fork or clone the repository.
2. Rename the product in `package.json`, README, UI copy, and deployment settings.
3. Keep `AI_PROVIDER=stub` until the rest of the app is running.
4. Run `pnpm db:setup`.
5. Run `pnpm check`.
6. Run `pnpm e2e`.
7. Replace prompt templates and AI provider configuration for your domain.

## What To Customize First

### Product Identity

Update:

- `package.json`
- `README.md`
- `src/app/layout.tsx`
- Document list and editor UI copy
- Deployment project name

### Prompt Templates

Default templates live in `src/db/seed.ts`.

Each template has:

- `name`
- `description`
- `category`
- `systemPrompt`
- `variableSchema`

The schema drives both the prompt template panel and route validation. Keep required variables explicit so users understand what they need to provide before running review.

Prompt templates also need to preserve the AI output contract. Review prompts must request exact `targetText` values from the provided document and drop-in `replacementText` edits. Rewrite and translation prompts should return `{ replacementText, explanation }` when possible, while plain text remains a backward-compatible fallback. See [PROMPTING.md](PROMPTING.md) before replacing templates.

The editor renders pending proposals as inline highlights. If your fork changes the editor schema, custom nodes, or collaboration model, keep proposal range metadata (`occurrenceIndex`, `targetFrom`, `targetTo`) aligned with the way your editor maps document positions.

For contract review products, start from the seeded `Contract Review` template rather than writing a generic legal prompt. Replace its playbook variables, clause categories, and risk language with your own review standards, then validate that findings still return exact `targetText` values and redline-ready `replacementText` values.

### AI Provider

The provider contract lives in `src/features/ai/providers.ts`.

The built-in provider modes are:

- `stub`: deterministic local output for tests and demos
- `coredot`: Core.Today OpenAI-compatible LLM proxy
- `anthropic`: Core.Today Anthropic messages proxy
- `gemini`: Core.Today Gemini generateContent proxy
- `openai`: direct OpenAI provider

Non-secret provider settings are stored in `app_settings` and can be changed from the editor's `LLM 설정` dialog. Keep provider API keys in server environment variables, not in UI state, localStorage, or the database.

If your product uses another provider, add it behind the same interface:

```ts
generateText(input)
streamText(input)
generateReview(input)
```

Do not call provider SDKs directly from UI components.

### Database

The starter uses SQLite/libSQL for fast local setup.

Good options for downstream projects:

- Keep SQLite/libSQL for single-tenant or internal tools.
- Use hosted libSQL/Turso-style deployments when the app shape still fits SQLite.
- Migrate to Postgres when you need stronger multi-tenant operational patterns, row-level access controls, or richer relational workloads.

See [ARCHITECTURE.md](ARCHITECTURE.md#sqlite-today-postgres-later).

## Add Authentication Carefully

This starter does not include authentication, users, or workspaces.

When adding auth:

1. Add owner columns to `documents`, `prompt_templates`, `ai_runs`, and `ai_proposals`.
2. Enforce ownership in repository queries.
3. Keep route handlers responsible for session extraction and permission checks.
4. Add tests for cross-user access denial.

Do not rely on client-side filtering for access control.

## Add Collaboration Later

The editor stores Tiptap JSON as the canonical body. This is enough for a single-user MVP.

For collaboration, introduce a sync layer deliberately:

- Yjs for real-time shared editing
- Separate update logs or snapshots for audit/history
- Background persistence from collaborative state to `documents.contentJson`

Keep AI review routes operating on explicit document snapshots so AI runs remain reproducible.

## Spellbook-Style Expansion Path

This starter implements a web-editor version of the core review loop: playbook-driven review, inline source highlights, redline previews, and accept/reject controls. To move closer to a full Spellbook-style legal workflow, extend in this order:

1. Add customer/vendor playbooks and clause libraries as first-class database tables.
2. Store organization-approved fallback clauses and preferred negotiation positions.
3. Add benchmark checks backed by your own precedents or licensed market data.
4. Review the built-in `.docx` import/export MVP against your document corpus, then extend it for comments, tracked changes, or an Office.js Word add-in if lawyers need those workflows directly in Word.
5. Add audit logs for accepted edits, rejected edits, provider responses, and user overrides.

## Keep E2E Tests Isolated

`pnpm e2e` prepares `data/e2e/coredot-e2e.db` and starts the app with:

```bash
AI_PROVIDER=stub
DATABASE_URL=file:./data/e2e/coredot-e2e.db
```

If you change database paths or Playwright config, preserve this isolation. E2E tests should never mutate production, staging, or a developer's normal local database.

## Fork Checklist

- [ ] Rename package and UI copy.
- [ ] Confirm license and copyright line.
- [ ] Set up `.env.local`.
- [ ] Run `pnpm db:setup`.
- [ ] Replace default prompt templates and run through the checklist in `docs/PROMPTING.md`.
- [ ] Decide provider mode: `stub`, `coredot`, `anthropic`, `gemini`, `openai`, or custom.
- [ ] Run `pnpm check`.
- [ ] Run `pnpm e2e`.
- [ ] Review `SECURITY.md` and vulnerability reporting path.
- [ ] Add auth and ownership before storing sensitive user documents.
