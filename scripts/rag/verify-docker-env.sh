#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "$REPO_ROOT"

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 [up|down|verify]" >&2
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_inline_comment() {
  local value="$1"
  local quote=""
  local i char previous

  for ((i = 0; i < ${#value}; i++)); do
    char="${value:i:1}"

    if [[ -n "$quote" ]]; then
      if [[ "$char" == "$quote" ]]; then
        quote=""
      fi
      continue
    fi

    if [[ "$char" == "'" || "$char" == '"' ]]; then
      quote="$char"
      continue
    fi

    if [[ "$char" == "#" ]]; then
      if [[ "$i" -eq 0 ]]; then
        printf ''
        return
      fi

      previous="${value:i-1:1}"
      if [[ "$previous" =~ [[:space:]] ]]; then
        trim "${value:0:i}"
        return
      fi
    fi
  done

  trim "$value"
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
    value="$(strip_inline_comment "$(trim "${line#*=}")")"

    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Invalid env key in ${env_file}: ${key}"

    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$env_file"
}

validate_port() {
  local name="$1"
  local value="$2"
  local source_file="$3"
  local port_number

  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    die "${name} must be an integer port between 1 and 65535; got '${value}' from ${source_file}."
  fi

  port_number=$((10#$value))
  if ((port_number < 1 || port_number > 65535)); then
    die "${name} must be an integer port between 1 and 65535; got '${value}' from ${source_file}."
  fi
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

  if ! printf 'GET /api/v2/heartbeat HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3; then
    exec 3<&-
    exec 3>&-
    return 1
  fi

  if ! IFS= read -r -t 5 status <&3; then
    exec 3<&-
    exec 3>&-
    return 1
  fi

  exec 3<&-
  exec 3>&-

  [[ "$status" == *" 200 "* ]]
}

check_chroma_heartbeat() {
  if command -v curl >/dev/null 2>&1; then
    local http_status
    http_status="$(curl -fsS --connect-timeout 2 --max-time 5 -o /dev/null -w "%{http_code}" "$CHROMA_HEARTBEAT_URL" 2>/dev/null)" || return 1
    [[ "$http_status" == "200" ]]
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

MODE="${1:-verify}"
if (($# > 1)); then
  usage
  die "Expected zero or one argument."
fi

case "$MODE" in
  up | down | verify)
    ;;
  *)
    usage
    die "Unknown mode: ${MODE}"
    ;;
esac

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
POSTGRES_PORT="${RAG_POSTGRES_PORT:-54329}"
CHROMA_PORT="${RAG_CHROMA_PORT:-8009}"
CHROMA_HEARTBEAT_URL="http://localhost:${CHROMA_PORT}/api/v2/heartbeat"

validate_port "RAG_POSTGRES_PORT" "$POSTGRES_PORT" "$SELECTED_ENV_FILE"
validate_port "RAG_CHROMA_PORT" "$CHROMA_PORT" "$SELECTED_ENV_FILE"

COMPOSE=(docker compose --env-file "$SELECTED_ENV_FILE" -f docker-compose.rag.yml)

case "$MODE" in
  up)
    "${COMPOSE[@]}" up -d
    exit 0
    ;;
  down)
    "${COMPOSE[@]}" down
    exit 0
    ;;
esac

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
