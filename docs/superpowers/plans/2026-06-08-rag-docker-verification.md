# RAG Docker Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker-based verification environment for RAG infrastructure using Postgres/pgvector and ChromaDB while keeping the Next.js app local.

**Architecture:** The Docker boundary is limited to verification services. `docker-compose.rag.yml` runs Postgres with pgvector and ChromaDB, while `scripts/rag/verify-docker-env.sh` validates service readiness and extension availability. Documentation explains how this stack supports future RAG, citation, and Postgres migration tests without changing the current SQLite-first app runtime.

**Tech Stack:** Docker Compose, Postgres/pgvector, ChromaDB, Bash, pnpm scripts, Markdown docs.

---

## File Structure

- Create `docker-compose.rag.yml`: Compose services, loopback-bound ports, volumes, and health checks for Postgres/pgvector and ChromaDB.
- Create `.env.docker.example`: non-secret local defaults for Docker service images, ports, and database credentials.
- Modify `.gitignore`: keep `.env.docker` ignored while allowing `.env.docker.example` to be committed.
- Create `.dockerignore`: exclude local dependencies, build outputs, database files, logs, and secrets from future Docker build contexts.
- Create `scripts/rag/verify-docker-env.sh`: single command verification script for Docker, Compose, pgvector, and Chroma heartbeat.
- Create `docs/RAG_DOCKER.md`: contributor guide for the verification stack.
- Modify `README.md`: add RAG Docker commands and docs pointer.
- Modify `docs/ROADMAP.md`: mention the v1.4 verification baseline.

## Task 1: Docker Compose Stack

**Files:**
- Create: `docker-compose.rag.yml`
- Create: `.env.docker.example`
- Modify: `.gitignore`
- Create: `.dockerignore`

- [ ] **Step 1: Add non-secret Docker environment defaults**

Create `.env.docker.example` with:

```dotenv
RAG_POSTGRES_IMAGE=pgvector/pgvector:pg16
RAG_POSTGRES_USER=coredot
RAG_POSTGRES_PASSWORD=coredot
RAG_POSTGRES_DB=coredot_rag
RAG_POSTGRES_PORT=54329
RAG_CHROMA_IMAGE=chromadb/chroma:1.5.3
RAG_CHROMA_PORT=8009
```

- [ ] **Step 2: Allow only the Docker example env file to be tracked**

Modify `.gitignore` env section so it includes:

```gitignore
# env files (can opt-in for committing if needed)
.env*
!.env.example
!.env.docker.example
```

- [ ] **Step 3: Add Docker ignore rules**

Create `.dockerignore` with:

```dockerignore
.git
.next
out
build
.vercel
node_modules
coverage
test-results
data
logs
secrets
*.db
*.db-*
*.sqlite
*.sqlite-*
*.tsbuildinfo
*.pem
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*
.env*
!.env.example
!.env.docker.example
```

- [ ] **Step 4: Add the RAG Docker Compose stack**

Create `docker-compose.rag.yml` with:

```yaml
services:
  postgres:
    image: ${RAG_POSTGRES_IMAGE:-pgvector/pgvector:pg16}
    environment:
      POSTGRES_USER: ${RAG_POSTGRES_USER:-coredot}
      POSTGRES_PASSWORD: ${RAG_POSTGRES_PASSWORD:-coredot}
      POSTGRES_DB: ${RAG_POSTGRES_DB:-coredot_rag}
    ports:
      - "127.0.0.1:${RAG_POSTGRES_PORT:-54329}:5432"
    volumes:
      - coredot_rag_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}",
        ]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped

  chroma:
    image: ${RAG_CHROMA_IMAGE:-chromadb/chroma:1.5.3}
    ports:
      - "127.0.0.1:${RAG_CHROMA_PORT:-8009}:8000"
    volumes:
      - coredot_rag_chroma_data:/data
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8000; printf \"GET /api/v2/heartbeat HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n\" >&3; read -r status <&3; [[ \"$${status}\" == *\" 200 \"* ]]'",
        ]
      interval: 10s
      timeout: 5s
      retries: 20
    restart: unless-stopped

volumes:
  coredot_rag_postgres_data:
  coredot_rag_chroma_data:
```

- [ ] **Step 5: Verify Compose syntax**

Run:

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml config
```

Expected: command exits successfully and prints normalized Compose configuration.

- [ ] **Step 6: Commit Task 1**

```bash
git add docker-compose.rag.yml .env.docker.example .gitignore .dockerignore
git commit -m "chore: add rag docker service stack"
```

## Task 2: Verification Script And Package Scripts

**Files:**
- Create: `scripts/rag/verify-docker-env.sh`
- Modify: `package.json`

- [ ] **Step 1: Add package scripts**

Modify `package.json` scripts with these entries:

```json
"docker:rag:up": "docker compose --env-file .env.docker.example -f docker-compose.rag.yml up -d",
"docker:rag:down": "docker compose --env-file .env.docker.example -f docker-compose.rag.yml down",
"docker:rag:verify": "bash scripts/rag/verify-docker-env.sh"
```

- [ ] **Step 2: Add the verification script**

Create `scripts/rag/verify-docker-env.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "$REPO_ROOT"

die() {
  echo "Error: $*" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local env_file="$1"
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"

    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue

    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="$(trim "$line")"
    fi

    [[ "$line" == *=* ]] || die "Invalid env line in ${env_file}: ${line}"

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Invalid env key in ${env_file}: ${key}"

    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$env_file"
}

print_logs() {
  local service="$1"
  "${COMPOSE[@]}" logs --tail=80 "$service" >&2 || true
}

wait_for_postgres() {
  local attempt

  for attempt in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  echo "Timed out waiting for Postgres service 'postgres'." >&2
  print_logs postgres
  return 1
}

check_chroma_tcp() {
  local status

  if ! exec 3<>"/dev/tcp/localhost/${CHROMA_PORT}"; then
    return 1
  fi

  printf 'GET /api/v2/heartbeat HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
  IFS= read -r status <&3 || true
  exec 3<&-
  exec 3>&-

  [[ "$status" == *" 200 "* ]]
}

check_chroma_heartbeat() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$CHROMA_HEARTBEAT_URL" >/dev/null 2>&1
  else
    check_chroma_tcp
  fi
}

wait_for_chroma() {
  local attempt

  for attempt in $(seq 1 60); do
    if check_chroma_heartbeat; then
      return 0
    fi

    sleep 1
  done

  echo "Timed out waiting for Chroma heartbeat at ${CHROMA_HEARTBEAT_URL}." >&2
  print_logs chroma
  return 1
}

command -v docker >/dev/null 2>&1 || die "docker command was not found."
docker compose version >/dev/null 2>&1 || die "docker compose is not available."
docker info >/dev/null 2>&1 || die "Docker daemon is not available."

SELECTED_ENV_FILE=".env.docker"
if [[ ! -f "$SELECTED_ENV_FILE" ]]; then
  SELECTED_ENV_FILE=".env.docker.example"
fi

[[ -f "$SELECTED_ENV_FILE" ]] || die "Selected env file is missing: ${SELECTED_ENV_FILE}"

load_env_file "$SELECTED_ENV_FILE"

POSTGRES_USER="${RAG_POSTGRES_USER:-coredot}"
POSTGRES_DB="${RAG_POSTGRES_DB:-coredot_rag}"
CHROMA_PORT="${RAG_CHROMA_PORT:-8009}"
CHROMA_HEARTBEAT_URL="http://localhost:${CHROMA_PORT}/api/v2/heartbeat"

COMPOSE=(docker compose --env-file "$SELECTED_ENV_FILE" -f docker-compose.rag.yml)

"${COMPOSE[@]}" up -d

wait_for_postgres

PGVECTOR_RESULT="$(
  "${COMPOSE[@]}" exec -T postgres psql \
    -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -tAc "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname = 'vector';"
)"

if [[ "$PGVECTOR_RESULT" != *vector* ]]; then
  echo "Postgres extension verification failed; expected pgvector result to contain 'vector'." >&2
  print_logs postgres
  exit 1
fi

wait_for_chroma

echo "RAG Docker verification passed."
echo "- Postgres: service postgres, database ${POSTGRES_DB}, pgvector enabled"
echo "- Chroma: ${CHROMA_HEARTBEAT_URL}"
```

- [ ] **Step 3: Make the script executable**

Run:

```bash
chmod +x scripts/rag/verify-docker-env.sh
```

- [ ] **Step 4: Verify package JSON parsing**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('package.json ok')"
```

Expected: prints `package.json ok`.

- [ ] **Step 5: Verify Docker stack when Docker is available**

Run:

```bash
pnpm docker:rag:verify
```

Expected: starts services and prints `RAG Docker verification passed.`

- [ ] **Step 6: Commit Task 2**

```bash
git add package.json scripts/rag/verify-docker-env.sh
git commit -m "chore: add rag docker verification script"
```

## Task 3: Documentation

**Files:**
- Create: `docs/RAG_DOCKER.md`
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Add RAG Docker guide**

Create `docs/RAG_DOCKER.md` with sections covering:

```markdown
# RAG Docker Verification

## Purpose

This stack runs the local services needed to verify future RAG, citation, and Postgres migration work. It runs Postgres/pgvector and ChromaDB in Docker. The Next.js app still runs locally with `pnpm dev` unless a future production Docker setup is added.

## Prerequisites

- Docker Desktop or Docker Engine with Compose v2
- pnpm 10 or newer

## Quick Start

```bash
pnpm docker:rag:verify
```

## Services

| Service | Compose service | Host port | Purpose |
| --- | --- | --- | --- |
| Postgres/pgvector | `postgres` | `54329` | Postgres migration and vector-search verification |
| ChromaDB | `chroma` | `8009` | Local vector-store comparison target |

## Local Overrides

Copy `.env.docker.example` to `.env.docker` to override ports, images, or local database credentials. `.env.docker` is ignored by git.

## Commands

```bash
pnpm docker:rag:up
pnpm docker:rag:verify
pnpm docker:rag:down
```

## Reset Volumes

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml down -v
```

## Relationship To SQLite

The app remains SQLite-first today. This Docker stack is a verification baseline for future retrieval and Postgres migration work, not a replacement for the current app database.

## Future Integration Tests

Future RAG tests should reuse this stack to validate document chunks, embedding metadata, vector similarity queries, citation source lookup, and citation verification failure cases.
```

- [ ] **Step 2: Add README command pointers**

Add the Docker RAG commands to the Common Commands list:

```bash
pnpm docker:rag:verify # Start and verify Postgres/pgvector + ChromaDB
pnpm docker:rag:up     # Start RAG verification services
pnpm docker:rag:down   # Stop RAG verification services
```

Add a short paragraph near the docs links:

```markdown
For RAG, citation, or Postgres migration experiments, use the Docker verification stack in [docs/RAG_DOCKER.md](docs/RAG_DOCKER.md). It runs Postgres/pgvector and ChromaDB in Docker while the app remains local.
```

- [ ] **Step 3: Update the roadmap**

Under `v1.4: Retrieval And Citation`, add:

```markdown
- Use the Docker RAG verification stack to validate pgvector, vector-store health, and future retrieval integration tests.
```

- [ ] **Step 4: Run documentation checks**

Run:

```bash
rg "RAG_DOCKER|docker:rag|pgvector|Chroma" README.md docs/ROADMAP.md docs/RAG_DOCKER.md
git diff --check
```

Expected: the references are present and `git diff --check` exits successfully.

- [ ] **Step 5: Commit Task 3**

```bash
git add docs/RAG_DOCKER.md README.md docs/ROADMAP.md
git commit -m "docs: document rag docker verification"
```

## Task 4: Final Verification

**Files:**
- No new files. This task verifies the full change set.

- [ ] **Step 1: Check git state and recent commits**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: branch is ahead with the new implementation commits and no unintended untracked files.

- [ ] **Step 2: Run static checks**

Run:

```bash
pnpm lint
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 3: Run Docker checks**

Run:

```bash
docker compose --env-file .env.docker.example -f docker-compose.rag.yml config
pnpm docker:rag:verify
```

Expected: Compose config is valid and the verification script passes. If Docker is unavailable, record the exact failure and still run the non-Docker checks.

- [ ] **Step 4: Run focused full safety check**

Run:

```bash
pnpm test
git diff --check
```

Expected: Vitest passes and no whitespace errors are reported.

- [ ] **Step 5: Final review**

Review:

```bash
git diff origin/main...HEAD --stat
git status --short
```

Expected: only intended Docker verification, docs, and plan/spec commits are present.
