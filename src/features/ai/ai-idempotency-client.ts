export type AiIdempotencyKeyCache = Map<string, string>;

type AiOperationEndpoint = "/api/ai/review" | "/api/ai/rewrite";

export type AiOperationPostResult<TBody> =
  | { body: TBody; ok: true; response: Response }
  | { ok: false; response: Response };

async function createAiRequestBodySignature(serializedBody: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedBody));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shouldRetainAiIdempotencyKey(response: Response) {
  return (response.status >= 500 && response.status <= 599) ||
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429;
}

function clearMatchingAiIdempotencyKey(
  cache: AiIdempotencyKeyCache,
  cacheKey: string,
  idempotencyKey: string,
) {
  if (cache.get(cacheKey) === idempotencyKey) {
    cache.delete(cacheKey);
  }
}

/**
 * A cache entry represents only an operation whose outcome is ambiguous. Initial
 * requests are never cached, so concurrent equal bodies still receive distinct
 * keys. Entries intentionally live for the lifetime of the editor shell: evicting
 * one can turn an ambiguous retry into a duplicate durable operation.
 */
export async function postAiOperation<TBody>(
  cache: AiIdempotencyKeyCache,
  endpoint: AiOperationEndpoint,
  serializedBody: string,
): Promise<AiOperationPostResult<TBody>> {
  const bodySignature = await createAiRequestBodySignature(serializedBody);
  const cacheKey = `${endpoint}:${bodySignature}`;
  const idempotencyKey = cache.get(cacheKey) ?? crypto.randomUUID();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: serializedBody,
    });

    if (!response.ok) {
      if (shouldRetainAiIdempotencyKey(response)) {
        cache.set(cacheKey, idempotencyKey);
      } else {
        clearMatchingAiIdempotencyKey(cache, cacheKey, idempotencyKey);
      }
      return { ok: false, response };
    }

    const body = await response.json() as TBody;
    clearMatchingAiIdempotencyKey(cache, cacheKey, idempotencyKey);
    return { body, ok: true, response };
  } catch (error) {
    cache.set(cacheKey, idempotencyKey);
    throw error;
  }
}
