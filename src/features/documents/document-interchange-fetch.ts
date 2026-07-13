export const DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS = 30_000;

export class DocumentInterchangeClientTimeoutError extends Error {
  constructor() {
    super("Document interchange request timed out");
    this.name = "DocumentInterchangeClientTimeoutError";
  }
}

export async function fetchDocumentInterchange<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  consumeResponse: (response: Response) => Promise<T>,
  timeoutMs = DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let rejectCallerAbort!: (reason: unknown) => void;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCallerAbort = reject;
  });
  const handleCallerAbort = () => {
    const reason = callerSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    controller.abort(reason);
    rejectCallerAbort(reason);
  };
  callerSignal?.addEventListener("abort", handleCallerAbort, { once: true });
  if (callerSignal?.aborted) {
    handleCallerAbort();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new DocumentInterchangeClientTimeoutError());
      reject(new DocumentInterchangeClientTimeoutError());
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return consumeResponse(response);
  })();

  try {
    return await Promise.race([request, timeout, callerAbort]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", handleCallerAbort);
  }
}
