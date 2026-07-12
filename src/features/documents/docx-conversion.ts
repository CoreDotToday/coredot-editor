import { Worker as NodeWorker } from "node:worker_threads";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { TiptapJson } from "@/db/schema";

type ImportResult = { contentJson: TiptapJson; warnings: string[] };
type WorkerRequest =
  | { bytes: Uint8Array; operation: "import" }
  | { contentJson: TiptapJson; operation: "export"; title: string }
  | { blockForMs: number; operation: "block-for-test" };
type WorkerResponse<T> =
  | { ok: true; protocol: "coredot-docx-worker-v1"; result: T }
  | { error: { message: string; name?: string; stack?: string }; ok: false; protocol: "coredot-docx-worker-v1" };

export function docxBufferToTiptapJson(buffer: Buffer, signal?: AbortSignal): Promise<ImportResult> {
  const bytes = Uint8Array.from(buffer);
  return runDocxWorker<ImportResult>({ bytes, operation: "import" }, signal, [bytes.buffer]);
}

export async function tiptapJsonToDocxBuffer(
  contentJson: TiptapJson,
  title = "Document",
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = await runDocxWorker<Uint8Array>({ contentJson, operation: "export", title }, signal);
  return Buffer.from(bytes);
}

export function runDocxWorkerForTests(input: { blockForMs: number }, signal?: AbortSignal): Promise<null> {
  if (process.env.NODE_ENV !== "test") throw new Error("DOCX worker test operation is test-only");
  return runDocxWorker<null>({ blockForMs: input.blockForMs, operation: "block-for-test" }, signal);
}

function runDocxWorker<T>(request: WorkerRequest, signal?: AbortSignal, transferList: ArrayBuffer[] = []): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

  return new Promise<T>((resolve, reject) => {
    // Turbopack cannot package node:worker_threads entries through the browser
    // worker URL transform. The production build emits one self-contained Node
    // worker and Next's documented output tracing includes it in deployment artifacts.
    const workerUrl = pathToFileURL(resolvePath(
      process.cwd(),
      process.env.NODE_ENV === "production"
        ? "src/features/documents/.generated/docx-conversion-worker.cjs"
        : "src/features/documents/docx-conversion-worker.mjs",
    ));
    // The worker bundle needs no parent test/dev loaders. Inheriting
    // loader hooks can inject protocol messages onto parentPort before ours.
    const WorkerConstructor = NodeWorker;
    const worker = new WorkerConstructor(workerUrl, { execArgv: [] });
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const handleAbort = () => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));

    signal?.addEventListener("abort", handleAbort, { once: true });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`DOCX conversion worker exited with code ${code}`)));
    });
    worker.on("message", (response: WorkerResponse<T>) => {
      if (!response || response.protocol !== "coredot-docx-worker-v1") return;
      if (response.ok) {
        finish(() => resolve(response.result));
      } else {
        const error = new Error(response.error.message);
        error.name = response.error.name ?? "Error";
        error.stack = response.error.stack ?? error.stack;
        finish(() => reject(error));
      }
    });
    worker.postMessage(request, transferList);
  });
}
