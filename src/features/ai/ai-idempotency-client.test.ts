import { afterEach, describe, expect, it, vi } from "vitest";
import { postAiOperation, type AiIdempotencyKeyCache } from "./ai-idempotency-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI client idempotency", () => {
  function requestKey(fetchMock: ReturnType<typeof vi.spyOn>, index: number) {
    return new Headers((fetchMock.mock.calls[index]![1] as RequestInit).headers).get("Idempotency-Key");
  }

  it("gives concurrent initial operations with the same body distinct keys", async () => {
    const cache: AiIdempotencyKeyCache = new Map();
    const resolveResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Promise<Response>((resolve) => resolveResponses.push(resolve)),
    );

    const first = postAiOperation(cache, "/api/ai/rewrite", "{\"same\":true}");
    const second = postAiOperation(cache, "/api/ai/rewrite", "{\"same\":true}");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(requestKey(fetchMock, 0)).not.toBe(requestKey(fetchMock, 1));
    resolveResponses[0]!(new Response("{}"));
    resolveResponses[1]!(new Response("{}"));
    await Promise.all([first, second]);
    expect(cache).toHaveLength(0);
  });

  it.each([408, 409, 429, 500, 503])("retains the same key after retryable status %i", async (status) => {
    const cache: AiIdempotencyKeyCache = new Map();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status }))
      .mockResolvedValueOnce(new Response("{}"));

    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");
    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");

    expect(requestKey(fetchMock, 1)).toBe(requestKey(fetchMock, 0));
    expect(cache).toHaveLength(0);
  });

  it("retains network and successful-body-read failures but clears after a consumed success", async () => {
    const cache: AiIdempotencyKeyCache = new Map();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("{}"));

    await expect(postAiOperation(cache, "/api/ai/rewrite", "{\"body\":1}"))
      .rejects.toBeInstanceOf(TypeError);
    await expect(postAiOperation(cache, "/api/ai/rewrite", "{\"body\":1}"))
      .rejects.toBeInstanceOf(SyntaxError);
    await postAiOperation(cache, "/api/ai/rewrite", "{\"body\":1}");
    await postAiOperation(cache, "/api/ai/rewrite", "{\"body\":1}");

    expect(requestKey(fetchMock, 1)).toBe(requestKey(fetchMock, 0));
    expect(requestKey(fetchMock, 2)).toBe(requestKey(fetchMock, 1));
    expect(requestKey(fetchMock, 3)).not.toBe(requestKey(fetchMock, 2));
  });

  it.each([302, 400])("clears a retained key after definitive status %i without parsing its body", async (status) => {
    const cache: AiIdempotencyKeyCache = new Map();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status: 500 }))
      .mockResolvedValueOnce(new Response("{", { status }))
      .mockResolvedValueOnce(new Response("{}"));

    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");
    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");
    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");

    expect(requestKey(fetchMock, 1)).toBe(requestKey(fetchMock, 0));
    expect(requestKey(fetchMock, 2)).not.toBe(requestKey(fetchMock, 1));
  });

  it("uses fresh keys for a changed body and for the same body on a different endpoint", async () => {
    const cache: AiIdempotencyKeyCache = new Map();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{", { status: 500 }),
    );

    await postAiOperation(cache, "/api/ai/review", "{\"body\":1}");
    await postAiOperation(cache, "/api/ai/review", "{\"body\":2}");
    await postAiOperation(cache, "/api/ai/rewrite", "{\"body\":1}");

    expect(new Set([requestKey(fetchMock, 0), requestKey(fetchMock, 1), requestKey(fetchMock, 2)]).size).toBe(3);
  });

  it("preserves the oldest ambiguous key after more than 64 distinct request bodies", async () => {
    const cache: AiIdempotencyKeyCache = new Map();
    const requestBodies = Array.from({ length: 65 }, (_, index) =>
      JSON.stringify({ command: `private-command-${index}`, documentId: "doc_1" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{", { status: 500 }),
    );

    for (const body of requestBodies) {
      await postAiOperation(cache, "/api/ai/review", body);
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [], review: {} })));
    await postAiOperation(cache, "/api/ai/review", requestBodies[0]!);

    const firstKey = requestKey(fetchMock, 0);
    const retryKey = requestKey(fetchMock, 65);
    expect(retryKey).toBe(firstKey);
    expect(cache).toHaveLength(64);
    expect([...cache.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/api\/ai\/review:[0-9a-f]{64}$/),
    ]));
    expect(JSON.stringify([...cache.keys()])).not.toContain("private-command");
  });
});
