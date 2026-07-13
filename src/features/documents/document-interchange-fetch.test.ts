import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDocumentInterchange, DocumentInterchangeClientTimeoutError } from "./document-interchange-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchDocumentInterchange", () => {
  it("keeps the deadline active while consuming the response body and aborts on timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const consumeBody = vi.fn(() => new Promise<Blob>(() => undefined));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return { ok: true } as Response;
    });

    const request = fetchDocumentInterchange(
      "/api/documents/doc/export",
      { method: "POST" },
      consumeBody,
      100,
    );
    const rejection = expect(request).rejects.toBeInstanceOf(DocumentInterchangeClientTimeoutError);
    await Promise.resolve();
    expect(consumeBody).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects promptly when the caller aborts even if response consumption ignores the signal", async () => {
    const caller = new AbortController();
    const consumeBody = vi.fn(() => new Promise<Blob>(() => undefined));
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const request = fetchDocumentInterchange(
      "/api/documents/doc/export",
      { method: "POST", signal: caller.signal },
      consumeBody,
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();

    caller.abort();

    await rejection;
  });
});
