# Maintainer Guide

This guide is for people maintaining a public fork of Coredot Editor.

## Release Checklist

1. Update `CHANGELOG.md`.
2. Confirm `package.json` version.
3. Load the fixed non-secret Clerk verification environment from [Configuration](configuration.md#production-verification). `pnpm build` intentionally fails without Clerk-mode configuration.
4. Run:

```bash
pnpm release:check
pnpm e2e:production
pnpm docs:build
pnpm docs:check-links
git diff --check
```

5. Check `git status --short` for generated artifacts.
6. Check that no real API keys are present outside ignored `.env*` files.
7. Tag the release if your fork uses tags.

The dependency audit reports all severities, blocks moderate-or-higher findings, and fails closed when the lockfile or npm bulk advisory response cannot be validated.

## Review Priorities

When reviewing pull requests, focus on:

- API route validation and error handling
- Data consistency between AI runs and proposals
- Prompt template schema compatibility
- Test isolation
- Accessibility of editor controls
- Database migration safety
- Avoiding committed secrets or local database files
- Dependency audit output and Dependabot updates

## Compatibility Policy

Coredot Editor is an application starter, not a published component package. Treat public APIs as documented app boundaries rather than semver-stable package exports unless a downstream fork explicitly publishes a package API.

Important boundaries:

- AI provider contract in `src/features/ai/providers.ts`
- Repository functions in `src/features/*/*-repository.ts`
- API route request and response shapes
- Template variable schema in `src/features/templates/template-validation.ts`

Document breaking changes in `CHANGELOG.md`.

## Issue Triage

Suggested labels:

- `bug`
- `documentation`
- `enhancement`
- `good first issue`
- `help wanted`
- `security`
- `question`

Close issues that require private data or security details in public, and redirect reporters to `SECURITY.md`.
