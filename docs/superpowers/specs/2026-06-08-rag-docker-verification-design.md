# RAG Docker Verification Design

## Context

Coredot Editor is currently a SQLite-first Next.js application. The roadmap includes retrieval, citation, and later Postgres migration work, but the repository does not yet provide a Docker environment for validating vector storage, retrieval backends, or citation-related integration checks.

The immediate goal is to add a verification-only Docker stack that lets contributors validate RAG infrastructure locally without changing the app runtime, introducing secrets into the repo, or forcing every developer to run the full application in containers.

## Selected Approach

Use a dedicated RAG verification stack, not full app Dockerization.

Postgres/pgvector and ChromaDB should run in Docker. The Next.js app should continue to run locally with `pnpm dev` for now. This gives contributors real database and vector-store services for verification while avoiding the extra maintenance cost of packaging the whole app before the runtime architecture is ready.

The stack should provide:

- Postgres with the `pgvector` extension enabled for Postgres migration and vector-search validation.
- ChromaDB as an optional local vector-store comparison target for future retrieval experiments.
- A deterministic verification script that starts or checks the services, validates pgvector availability, and checks vector-store health.
- Documentation that explains when to use this stack, how it relates to the current SQLite app, and how future RAG tests should plug into it.

This keeps the work useful for RAG and Postgres readiness while avoiding premature production container design.

## Goals

- Add local Docker Compose support for RAG verification services.
- Keep service configuration non-secret and safe for open-source distribution.
- Make verification easy to run with a single package script.
- Document the boundary between the current SQLite app and the Docker verification stack.
- Prepare a path for future retrieval tests, citation verification tests, and Postgres migration checks.

## Non-Goals

- Do not move the main application from SQLite/libSQL to Postgres in this change.
- Do not containerize the Next.js app in this change.
- Do not implement document ingestion, embeddings, RAG retrieval, or citation validation in this change.
- Do not add real LLM API keys, embedding-provider keys, or private service credentials.
- Do not add CI Docker jobs until repository-level RAG tests exist.

## Proposed Files

- `docker-compose.rag.yml`: verification services for Postgres/pgvector and ChromaDB.
- `.env.docker.example`: local, non-secret defaults for service ports and database credentials.
- `.dockerignore`: keeps local dependencies, build outputs, data, and secrets out of future Docker build contexts.
- `scripts/rag/verify-docker-env.sh`: starts the verification stack if needed and checks service readiness.
- `docs/RAG_DOCKER.md`: contributor guide for running and extending the stack.
- `README.md`: short pointer to the RAG Docker guide.
- `docs/ROADMAP.md`: clarify that v1.4 retrieval work now has an infrastructure verification baseline.

## Docker Services

These services are the Docker boundary for this phase. The app does not connect to them by default until future RAG or Postgres migration code is added.

### Postgres With pgvector

The Postgres service should use a pgvector-enabled image and expose a non-default host port to avoid conflicts with local development databases. It should persist data in a named Docker volume so repeated verification does not require re-initialization.

Verification should run SQL equivalent to:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extname FROM pg_extension WHERE extname = 'vector';
```

Future RAG tests can add tables with vector columns and nearest-neighbor checks once ingestion and embedding code exists.

### ChromaDB

The Chroma service should run as an optional local vector-store target. The first verification step should only check HTTP availability. Deeper collection, insertion, and query checks should be added when the app has a retrieval abstraction.

If Chroma is unavailable or its HTTP health endpoint changes, the script should fail with a clear message that identifies the service and endpoint being checked.

## Script Behavior

`pnpm docker:rag:verify` should:

1. Confirm Docker and Docker Compose are available.
2. Start `docker-compose.rag.yml` in detached mode.
3. Wait for Postgres to accept connections.
4. Enable and verify the `vector` extension.
5. Check Chroma HTTP health.
6. Print concise success or failure messages.

The script should not tear down services by default. Contributors often need the stack to remain available while running later tests. A separate `pnpm docker:rag:down` script should stop and remove the services.

## Package Scripts

Add these scripts:

```json
{
  "docker:rag:up": "docker compose --env-file .env.docker.example -f docker-compose.rag.yml up -d",
  "docker:rag:down": "docker compose --env-file .env.docker.example -f docker-compose.rag.yml down",
  "docker:rag:verify": "bash scripts/rag/verify-docker-env.sh"
}
```

The verification script can read `.env.docker` when present and fall back to `.env.docker.example`. This lets contributors override ports without modifying tracked files.

## Data And Secrets

- `.env.docker.example` must contain only local development defaults.
- `.env.docker` should be ignored by git.
- API keys must remain in `.env.local` or the deployment environment.
- Docker volumes should be named and documented so contributors can reset them intentionally.

## Error Handling

- Missing Docker daemon: fail with a message telling the contributor to start Docker.
- Port conflicts: fail with the conflicting host port and point to `.env.docker`.
- Postgres startup timeout: print recent service logs.
- pgvector missing: fail explicitly instead of continuing with degraded behavior.
- Chroma health failure: fail explicitly, because future RAG verification should not silently skip a vector-store dependency.

## Testing Strategy

Repository verification for this change should include:

- `docker compose --env-file .env.docker.example -f docker-compose.rag.yml config`
- `pnpm docker:rag:verify` when Docker is available.
- `pnpm lint`
- `pnpm typecheck`
- Targeted tests are not required unless implementation touches application code.

When future RAG application code lands, add integration tests that run against this Docker stack and validate:

- document chunk persistence
- embedding metadata persistence
- vector similarity query behavior
- citation source lookup
- citation verification failure cases

## Documentation Requirements

`docs/RAG_DOCKER.md` should explain:

- why this stack exists
- prerequisites
- setup commands
- service ports and override file
- how to reset volumes
- how this relates to SQLite today and Postgres later
- how future RAG modules should add integration tests

The README should include only a short pointer so the top-level setup path stays simple.

## Acceptance Criteria

- A contributor can run one command to verify the local RAG service stack.
- pgvector availability is checked through a real Postgres connection inside Docker.
- Chroma availability is checked through HTTP.
- The main app still runs the same way as before.
- No secrets are committed.
- Documentation is clear enough for open-source contributors to extend the stack for future RAG tests.
