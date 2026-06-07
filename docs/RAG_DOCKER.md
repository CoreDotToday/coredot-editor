# RAG Docker Verification

## Purpose

The RAG Docker verification stack gives maintainers a repeatable way to check the external services needed for future retrieval and citation work.

It starts Postgres with pgvector and ChromaDB in Docker while the Next.js app continues to run locally. This keeps the current SQLite development flow intact and avoids turning local app startup into a Docker-only workflow.

## Prerequisites

- Docker with Docker Compose v2.
- pnpm dependencies installed with `pnpm install`.
- Host ports `54329` and `8009` available, unless overridden in `.env.docker`.

The verification script fails early when the `docker` command, Docker Compose, or the Docker daemon is unavailable.

## Quick Start

Start the stack:

```bash
pnpm docker:rag:up
```

Verify that Postgres, pgvector, and ChromaDB are healthy:

```bash
pnpm docker:rag:verify
```

Stop the stack when finished:

```bash
pnpm docker:rag:down
```

## Services

| Service | Default host port | Purpose |
| --- | --- | --- |
| `postgres` | `127.0.0.1:54329` | Runs Postgres with pgvector for vector schema and migration experiments. |
| `chroma` | `127.0.0.1:8009` | Runs ChromaDB for vector-store health checks and future retrieval tests. |

Both services are bound to loopback addresses only. The stack does not expose either service on the public network interface.

The example Postgres credentials are `coredot` / `coredot`, and the local Chroma service is unauthenticated. This stack is local-only. Do not expose these ports beyond `127.0.0.1` or reuse the example defaults for shared or production environments.

## Local Overrides

The verification script uses `.env.docker` when that file exists. If it is missing, the script falls back to `.env.docker.example`.

Create a local override file when you need different images, credentials, database names, or host ports:

```bash
cp .env.docker.example .env.docker
```

Common overrides:

```bash
RAG_POSTGRES_PORT=54330
RAG_CHROMA_PORT=8010
```

Do not commit machine-specific `.env.docker` values unless they are intentionally shared defaults.

## Commands

```bash
pnpm docker:rag:up
```

Starts `postgres` and `chroma` in detached mode using `docker-compose.rag.yml`.

```bash
pnpm docker:rag:verify
```

Starts the stack if needed, waits for Postgres, creates the `vector` extension if needed, checks that pgvector is installed, and verifies the Chroma heartbeat endpoint.

```bash
pnpm docker:rag:down
```

Stops the stack without deleting persisted service data.

## Reset Volumes

Use `down -v` when you need a clean Postgres and ChromaDB data set.

With the checked-in example environment:

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml down -v
```

With local overrides:

```bash
docker compose --env-file .env.docker -f docker-compose.rag.yml down -v
```

Do not rely on fixed volume names in scripts or docs. The Compose project name can change based on how the stack is invoked.

## Relationship To SQLite

SQLite/libSQL remains the default application database. The RAG Docker stack does not change `DATABASE_URL`, run Drizzle migrations for the app, or replace the local SQLite development database.

Use this stack for RAG, citation, pgvector, vector-store, and Postgres migration experiments while continuing to run the Next.js app with `pnpm dev`.

## Future Integration Tests

Future retrieval integration tests should use this stack to validate:

- Postgres connectivity and pgvector extension availability.
- Vector-store readiness through ChromaDB health checks.
- Retrieval schema migrations before app-level RAG code depends on them.
- Document ingestion, embedding writes, retrieval queries, and citation metadata round trips.

Keep those tests explicit about their Docker dependency so the default unit and component test loops stay fast.

## Troubleshooting

### Docker daemon unavailable

If a command fails with a Docker daemon error, start Docker Desktop or your Docker daemon and retry:

```bash
pnpm docker:rag:verify
```

### Port conflicts

If Postgres or Chroma cannot bind to the default host ports, create `.env.docker` and set unused loopback ports:

```bash
RAG_POSTGRES_PORT=54330
RAG_CHROMA_PORT=8010
```

Then rerun:

```bash
pnpm docker:rag:verify
```

### pgvector verification failure

`pnpm docker:rag:verify` runs `CREATE EXTENSION IF NOT EXISTS vector` in the `postgres` service and checks that the extension exists. If this fails, inspect the Postgres logs:

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml logs postgres
```

If you use `.env.docker`, pass that file instead:

```bash
docker compose --env-file .env.docker -f docker-compose.rag.yml logs postgres
```

Confirm that `RAG_POSTGRES_IMAGE` points to an image that includes pgvector, such as `pgvector/pgvector:pg16`.

### Chroma heartbeat failure

The verification script checks:

```text
http://localhost:8009/api/v2/heartbeat
```

When `RAG_CHROMA_PORT` is overridden, use that port instead. If the heartbeat times out, inspect Chroma logs:

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml logs chroma
```

If you use `.env.docker`, pass that file instead:

```bash
docker compose --env-file .env.docker -f docker-compose.rag.yml logs chroma
```

Confirm that the configured Chroma image starts successfully and that no other local process is using the selected port.
