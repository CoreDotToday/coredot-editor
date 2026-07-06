# Getting Started

This guide gets a local copy running with deterministic AI behavior and an isolated SQLite database.

## Requirements

- Node.js 20 or newer.
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

The example environment uses `AI_PROVIDER=stub`, so review and rewrite flows return deterministic local output. You can explore the proposal workflow without an OpenAI or Core.Today key.

## First Document Flow

1. Open the document list.
2. Create a document or import a `.docx` file.
3. Edit the title and body.
4. Select a prompt template in the left panel.
5. Run an AI review or use the bottom command bar for a rewrite.
6. Review pending proposals in the right workspace.
7. Accept, insert below, reject, or bulk-handle proposals.
8. Save the document.

Accepted proposals are applied through the server-side proposal apply route, which updates the saved document and proposal status in the same transaction.

## Verify The Local Checkout

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
