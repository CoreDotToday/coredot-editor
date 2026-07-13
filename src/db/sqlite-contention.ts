const DEFAULT_ATTEMPTS = 7;
const DEFAULT_INITIAL_DELAY_MS = 10;
const DEFAULT_MAX_DELAY_MS = 100;
const MAX_ATTEMPTS = 10;
const MAX_CAUSE_DEPTH = 8;

type RetrySqliteContentionOptions = {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Retry only operations whose thrown SQLite contention error proves they did not commit.
 * Callers remain responsible for choosing an operation boundary that is safe to repeat.
 */
export async function retrySqliteContention<T>(
  operation: () => Promise<T>,
  options: RetrySqliteContentionOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? delay;

  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new Error(`SQLite contention retry attempts must be between 1 and ${String(MAX_ATTEMPTS)}`);
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error("SQLite contention initial delay must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error("SQLite contention maximum delay must be an integer at least as large as the initial delay");
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableSqliteContention(error) || attempt + 1 >= attempts) {
        throw error;
      }

      await sleep(Math.min(initialDelayMs * 2 ** attempt, maxDelayMs));
    }
  }

  throw new Error("SQLite contention retry exhausted unexpectedly");
}

export function isRetryableSqliteContention(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      return false;
    }
    seen.add(current);

    const code = "code" in current ? String(current.code).toUpperCase() : "";
    const message = "message" in current ? String(current.message) : "";
    if (
      code.startsWith("SQLITE_BUSY") ||
      code.startsWith("SQLITE_LOCKED") ||
      /database (?:is )?locked/i.test(message)
    ) {
      return true;
    }

    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
