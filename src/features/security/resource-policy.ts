import { NextResponse } from "next/server";

export const RESOURCE_LIMITS = Object.freeze({
  docxBytes: 10 * 1024 * 1024,
  documentJsonBytes: 10 * 1024 * 1024,
  documentDepth: 64,
  documentNodes: 100_000,
  operationMs: 30_000,
});
const DOCUMENT_JSON_ENVELOPE_BYTES = 1024 * 1024;

type TiptapLimits = { documentDepth: number; documentJsonBytes?: number; documentNodes: number };
type TiptapValidation =
  | { depth: number; nodes: number; ok: true }
  | { limit: "documentDepth" | "documentJsonBytes" | "documentNodes" | "malformed"; ok: false };

export class OperationTimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export function validateTiptapResource(
  root: unknown,
  limits: TiptapLimits = RESOURCE_LIMITS,
): TiptapValidation {
  if (!isNode(root) || root.type !== "doc") {
    return { limit: "malformed", ok: false };
  }

  const maxJsonBytes = limits.documentJsonBytes ?? RESOURCE_LIMITS.documentJsonBytes;
  const seen = new WeakSet<object>();
  const stack: Array<{ arrayNodeDepth?: number; nodeDepth?: number; value: unknown }> = [
    { nodeDepth: 1, value: root },
  ];
  let maxDepth = 0;
  let nodes = 0;
  let jsonBytes = 0;

  const addBytes = (bytes: number) => {
    jsonBytes += bytes;
    return jsonBytes <= maxJsonBytes;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.nodeDepth !== undefined && !isNode(current.value)) {
      return { limit: "malformed", ok: false };
    }

    if (current.value === null) {
      if (!addBytes(4)) return { limit: "documentJsonBytes", ok: false };
      continue;
    }
    if (typeof current.value === "string") {
      if (!addJsonStringBytes(current.value, addBytes)) return { limit: "documentJsonBytes", ok: false };
      continue;
    }
    if (typeof current.value === "number") {
      if (!addBytes(Number.isFinite(current.value) ? String(current.value).length : 4)) {
        return { limit: "documentJsonBytes", ok: false };
      }
      continue;
    }
    if (typeof current.value === "boolean") {
      if (!addBytes(current.value ? 4 : 5)) return { limit: "documentJsonBytes", ok: false };
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      return { limit: "malformed", ok: false };
    }
    if (seen.has(current.value)) return { limit: "malformed", ok: false };
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (!addBytes(2 + Math.max(0, current.value.length - 1))) {
        return { limit: "documentJsonBytes", ok: false };
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ nodeDepth: current.arrayNodeDepth, value: current.value[index] });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return { limit: "malformed", ok: false };
    if (current.nodeDepth !== undefined) {
      if (!isNode(current.value)) return { limit: "malformed", ok: false };
      nodes += 1;
      if (nodes > limits.documentNodes) return { limit: "documentNodes", ok: false };
      if (current.nodeDepth > limits.documentDepth) return { limit: "documentDepth", ok: false };
      maxDepth = Math.max(maxDepth, current.nodeDepth);
    }

    const entries = Object.entries(current.value);
    if (!addBytes(2 + Math.max(0, entries.length - 1))) {
      return { limit: "documentJsonBytes", ok: false };
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;
      if (!addJsonStringBytes(key, addBytes) || !addBytes(1)) {
        return { limit: "documentJsonBytes", ok: false };
      }
      if (current.nodeDepth !== undefined && key === "content") {
        if (!Array.isArray(value)) return { limit: "malformed", ok: false };
        stack.push({ arrayNodeDepth: current.nodeDepth + 1, value });
      } else {
        stack.push({ value });
      }
    }
  }

  return { depth: maxDepth, nodes, ok: true };
}

export async function withOperationTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = RESOURCE_LIMITS.operationMs,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resourcePolicyErrorResponse(error: unknown): Response | null {
  if (error instanceof OperationTimeoutError) {
    return NextResponse.json({ error: "Operation timed out" }, { status: 504 });
  }
  return null;
}

export function requestExceedsDocumentBodyLimit(request: Request) {
  const contentLength = request.headers?.get("content-length");
  return contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > RESOURCE_LIMITS.documentJsonBytes + DOCUMENT_JSON_ENVELOPE_BYTES;
}

export function documentResourceLimitResponse() {
  return NextResponse.json({ error: "Document exceeds resource limits" }, { status: 413 });
}

function isNode(value: unknown): value is Record<string, unknown> & { type: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function addJsonStringBytes(value: string, addBytes: (bytes: number) => boolean) {
  if (!addBytes(2)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      if (!addBytes(2)) return false;
    } else if (code <= 0x1f) {
      if (!addBytes(6)) return false;
    } else if (code <= 0x7f) {
      if (!addBytes(1)) return false;
    } else if (code <= 0x7ff) {
      if (!addBytes(2)) return false;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        if (!addBytes(4)) return false;
      } else if (!addBytes(6)) {
        return false;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (!addBytes(6)) return false;
    } else if (!addBytes(3)) {
      return false;
    }
  }
  return true;
}
