# Contributing

Thanks for helping improve Coredot Editor. This project is intended to be a practical open-source starter for AI-assisted document products, so contributions should keep the app easy to understand, fork, and adapt.

## Before You Start

- Search existing issues and pull requests first.
- Keep changes focused. A pull request should usually handle one feature, bug fix, or documentation improvement.
- Prefer the existing architecture and local helper APIs over new abstractions.
- Add tests when changing behavior.

## Local Setup

```bash
pnpm install
cp .env.example .env.local
pnpm db:setup
pnpm dev
```

The default AI provider is `stub`, so local development does not require an external API key.

When setup instructions, dependencies, or public documentation change, verify that this clean-room path still works:

```bash
pnpm docs:verify-quick-start
```

## Development Workflow

1. Create a branch from `main`.
2. Make the smallest coherent change.
3. Run focused tests while developing.
4. Run the main application finish line before opening a PR:

```bash
pnpm release:check
```

`pnpm e2e` uses an isolated SQLite database under `data/e2e/` and should not mutate your local development database.

If you need to verify only the production build, use the same fixed Clerk values as CI:

```bash
AUTH_MODE=clerk \
CLERK_SECRET_KEY=sk_test_ci_build \
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k \
pnpm build
```

These are test-shaped verification values, never production credentials. Real deployments must provide their own Clerk keys.

When changing public documentation, install the docs toolchain and build the site in strict mode:

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
pnpm docs:check-links && pnpm docs:build
```

Keep `docs/` publishable. Do not commit agent-only plans, private implementation notes, customer material, or unreleased security details under the public docs tree.

## Code Style

- Use TypeScript and Zod at API boundaries.
- Keep repository functions small and explicit.
- Keep route handlers defensive: bad JSON should return `400`, missing records should return `404`, provider failures should not leave contradictory database state.
- Keep UI copy concise and product-facing.
- Prefer accessible role-based selectors in tests.

## Database Changes

When changing `src/db/schema.ts`, generate and commit a migration:

```bash
pnpm db:generate
pnpm db:migrate
pnpm test
```

Do not commit generated SQLite database files.

## AI Provider Changes

Provider implementations live in `src/features/ai/providers.ts`.

Keep the provider contract stable:

- `generateText`
- `streamText`
- `generateReview`

New provider behavior should be covered by tests and should not require live credentials for the default test suite.

## Pull Request Checklist

- [ ] The change has a clear scope.
- [ ] Public behavior is documented if needed.
- [ ] Tests cover new or changed behavior.
- [ ] `pnpm release:check` passes for main application changes.
- [ ] `pnpm e2e` passes when the change touches user flows.
- [ ] `pnpm docs:verify-quick-start` passes when setup or documentation changes.
- [ ] `pnpm docs:check-links && pnpm docs:build` passes when the change touches `docs/`, `mkdocs.yml`, or documentation navigation.
- [ ] No database files, `.env` files, traces, or generated build artifacts are committed.

## Reporting Bugs

Include:

- What you expected
- What happened
- Steps to reproduce
- Relevant command output or screenshots
- Environment details: OS, Node version, pnpm version, database URL type, AI provider
