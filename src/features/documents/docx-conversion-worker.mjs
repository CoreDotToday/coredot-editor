import { parentPort } from "node:worker_threads";
import { docxBufferToTiptapJsonCore, tiptapJsonToDocxBufferCore } from "./docx-conversion-core.mjs";

if (!parentPort) throw new Error("DOCX worker requires a parent port");

parentPort.once("message", async (message) => {
  try {
    if (message.operation === "import") {
      const result = await docxBufferToTiptapJsonCore(message.bytes);
      parentPort.postMessage({ ok: true, protocol: "coredot-docx-worker-v1", result });
      return;
    }
    if (message.operation === "export") {
      const result = new Uint8Array(await tiptapJsonToDocxBufferCore(message.contentJson, message.title));
      parentPort.postMessage({ ok: true, protocol: "coredot-docx-worker-v1", result }, [result.buffer]);
      return;
    }
    if (message.operation === "block-for-test") {
      const endAt = performance.now() + message.blockForMs;
      while (performance.now() < endAt) {
        // Deliberately occupy only the worker thread for cancellation verification.
      }
      parentPort.postMessage({ ok: true, protocol: "coredot-docx-worker-v1", result: null });
      return;
    }
    throw new Error("Unknown DOCX worker operation");
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? { message: error.message, name: error.name, stack: error.stack } : { message: String(error) },
      ok: false,
      protocol: "coredot-docx-worker-v1",
    });
  }
});
