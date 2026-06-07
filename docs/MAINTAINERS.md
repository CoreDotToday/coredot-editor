# Maintainer Guide

This guide is for people maintaining a public fork of Coredot Editor.

## Release Checklist

1. Update `CHANGELOG.md`.
2. Confirm `package.json` version.
3. Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm security:audit
git diff --check
```

4. Check `git status --short` for generated artifacts.
5. Check that no real API keys are present outside ignored `.env*` files.
6. Tag the release if your fork uses tags.

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

Until `1.0.0`, treat public APIs as the documented app boundaries rather than semver-stable package exports.

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
