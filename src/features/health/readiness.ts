export const READINESS_DATABASE_QUERY = "SELECT execution_token FROM ai_runs LIMIT 0";
export const READINESS_TIMEOUT_MS = 1_000;

type ReadinessDatabase = {
  execute(statement: string): Promise<unknown> | unknown;
};

type ReadinessHandlerOptions = {
  includeBody?: boolean;
  timeoutMs?: number;
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export function createReadinessHandler(
  database: ReadinessDatabase,
  options: ReadinessHandlerOptions = {},
) {
  const includeBody = options.includeBody ?? true;
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;

  return async function handleReadiness(request: Request) {
    const ready = await checkDatabaseReadiness(database, request.signal, timeoutMs);
    const status = ready ? 200 : 503;

    if (!includeBody) {
      return new Response(null, {
        headers: NO_STORE_HEADERS,
        status,
      });
    }

    return Response.json(
      { status: ready ? "ready" : "unavailable" },
      {
        headers: NO_STORE_HEADERS,
        status,
      },
    );
  };
}

async function checkDatabaseReadiness(
  database: ReadinessDatabase,
  signal: AbortSignal,
  timeoutMs: number,
) {
  if (signal.aborted) return false;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const databaseResult = Promise.resolve()
    .then(() => database.execute(READINESS_DATABASE_QUERY))
    .then(
      () => true,
      () => false,
    );
  const timeoutResult = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const abortResult = new Promise<boolean>((resolve) => {
    const handleAbort = () => resolve(false);
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
    if (signal.aborted) handleAbort();
  });

  try {
    return await Promise.race([databaseResult, timeoutResult, abortResult]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}
