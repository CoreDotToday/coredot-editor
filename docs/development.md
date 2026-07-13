# Development

This page summarizes the commands and workflow maintainers should use when changing the app or documentation.

## Local Commands

`pnpm build` and `pnpm check` create a production build and therefore require Clerk-mode verification configuration or real deployment keys. Load the fixed non-secret values in [Configuration](configuration.md#production-verification) before using them; production fail-fast behavior is intentional.

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm check
pnpm security:audit
```

Use focused tests while editing and run the full relevant gate before committing.

## Documentation Commands

Install docs dependencies:

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
```

Serve docs locally:

```bash
pnpm docs:serve
```

Build docs in strict mode:

```bash
pnpm docs:build
```

The docs source lives in `docs/`. The generated static site is written to `site/` and should not be committed.

## Test Strategy

- Repository tests use isolated temporary databases.
- Route tests mock repositories and providers where appropriate.
- Component tests use Testing Library.
- E2E tests use Playwright with an isolated SQLite database at `data/e2e/coredot-e2e.db`.
- Documentation builds use MkDocs strict mode so broken links and invalid config fail CI.

## Pull Request Expectations

Before opening a pull request:

1. Keep the change focused.
2. Update public docs when behavior, route contracts, or extension points change.
3. Add or update tests for changed behavior.
4. Load the documented verification-only Clerk environment, then run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
5. Run `pnpm e2e` when user flows change.
6. Run `pnpm docs:build` when documentation changes.

Read the repository [contribution guide](https://github.com/CoreDotToday/coredot-editor/blob/main/CONTRIBUTING.md) for more detail.
