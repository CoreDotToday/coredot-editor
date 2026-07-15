# Getting Started

This guide gets a local copy running with deterministic AI behavior and an isolated SQLite database.

## Requirements

- Node.js 20.19+, 22.13+, or 24+.
- pnpm 10 or newer.
- Python 3.12 or newer only when building the documentation site.

## Install

```bash
pnpm install
cp .env.example .env.local
pnpm db:setup
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

The example environment uses `AI_PROVIDER=stub`, so review and rewrite flows return deterministic local output. It also uses `AUTH_MODE=test`, which supplies one deterministic local owner and Workspace. You can explore the complete workflow without Clerk, OpenAI, or Core.Today credentials, but test authentication is rejected by production builds and startup.

## First Document Flow

1. Open the document list.
2. Create a document or import a `.docx` file.
3. Edit the title and body.
4. Select a prompt template in the left panel.
5. Run an AI review or use the bottom command bar for a rewrite.
6. Review pending proposals in the right workspace.
7. Accept, insert below, reject, or bulk-handle proposals.
8. Save the document.

Accepted Proposals are applied through the revision-aware document-change service, which commits the submitted draft, Proposal status, and durable Document Change in one transaction.

## Verify The Local Checkout

`pnpm build`, `pnpm check`, and `pnpm release:check` create a production build. Production authentication intentionally fails closed, so load these fixed non-secret test-format values for local verification:

```bash
export AUTH_MODE=clerk
export CLERK_SECRET_KEY=sk_test_ci_build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
```

They satisfy configuration validation only and do not authenticate users. A deployed instance requires real Clerk keys from its secret manager.

Use the fast local gate while developing:

```bash
pnpm check
```

Run the full release-style gate before publishing a fork or opening a larger pull request:

```bash
pnpm release:check
```

`pnpm e2e` creates and uses `data/e2e/coredot-e2e.db` so browser tests do not mutate the development database.

## Build The Documentation Site

Install the documentation toolchain:

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
```

Serve docs locally:

```bash
pnpm docs:serve
```

Build the static site:

```bash
pnpm docs:build
```

The generated site goes to `site/` and is published by the GitHub Pages workflow on pushes to `main`.
