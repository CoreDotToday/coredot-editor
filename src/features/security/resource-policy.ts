import { NextResponse } from "next/server";

export const RESOURCE_LIMITS = Object.freeze({
  docxBytes: 10 * 1024 * 1024,
  documentJsonBytes: 10 * 1024 * 1024,
  documentDepth: 64,
  documentNodes: 100_000,
  operationMs: 30_000,
});
const DOCUMENT_JSON_ENVELOPE_BYTES = 1024 * 1024;
export const DOCUMENT_REQUEST_BODY_BYTES = RESOURCE_LIMITS.documentJsonBytes + DOCUMENT_JSON_ENVELOPE_BYTES;

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

export class RequestBodyTooLargeError extends Error {
  constructor(message = "Request body exceeds resource limits") {
    super(message);
    this.name = "RequestBodyTooLargeError";
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
  type Frame =
    | { generalContainerDepth: number; kind: "array"; index: number; nodeDepth?: number; value: unknown[] }
    | {
        firstProperty: boolean;
        generalContainerDepth: number;
        iterator: Generator<readonly [string, unknown], void>;
        kind: "object";
        nodeDepth?: number;
      }
    | {
        arrayNodeDepth?: number;
        generalContainerDepth: number;
        kind: "value";
        nodeDepth?: number;
        value: unknown;
      };
  // Structural Tiptap nodes and their content arrays use nodeDepth. A zero
  // general depth keeps that structural chain independent from attrs/marks.
  const stack: Frame[] = [{ generalContainerDepth: 0, kind: "value", nodeDepth: 1, value: root }];
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
    if (current.kind === "array") {
      if (current.index >= current.value.length) {
        if (!addBytes(1)) return { limit: "documentJsonBytes", ok: false };
        continue;
      }
      if (current.index > 0 && !addBytes(1)) return { limit: "documentJsonBytes", ok: false };
      stack.push({ ...current, index: current.index + 1 });
      stack.push({
        generalContainerDepth:
          current.nodeDepth === undefined ? current.generalContainerDepth + 1 : 0,
        kind: "value",
        nodeDepth: current.nodeDepth,
        value: current.value[current.index],
      });
      continue;
    }
    if (current.kind === "object") {
      const next = current.iterator.next();
      if (next.done) {
        if (!addBytes(1)) return { limit: "documentJsonBytes", ok: false };
        continue;
      }
      const [key, value] = next.value;
      if (!current.firstProperty && !addBytes(1)) {
        return { limit: "documentJsonBytes", ok: false };
      }
      if (!addJsonStringBytes(key, addBytes) || !addBytes(1)) {
        return { limit: "documentJsonBytes", ok: false };
      }
      stack.push({ ...current, firstProperty: false });
      if (current.nodeDepth !== undefined && key === "content") {
        if (!Array.isArray(value)) return { limit: "malformed", ok: false };
        stack.push({
          arrayNodeDepth: current.nodeDepth + 1,
          generalContainerDepth: 0,
          kind: "value",
          value,
        });
      } else {
        stack.push({
          generalContainerDepth:
            current.nodeDepth === undefined ? current.generalContainerDepth + 1 : 1,
          kind: "value",
          value,
        });
      }
      continue;
    }
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
    if (current.generalContainerDepth > limits.documentDepth) {
      return { limit: "documentDepth", ok: false };
    }
    if (seen.has(current.value)) return { limit: "malformed", ok: false };
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (!addBytes(1)) return { limit: "documentJsonBytes", ok: false };
      if (current.arrayNodeDepth !== undefined && current.value.length > limits.documentNodes - nodes) {
        return { limit: "documentNodes", ok: false };
      }
      stack.push({
        generalContainerDepth: current.generalContainerDepth,
        kind: "array",
        index: 0,
        nodeDepth: current.arrayNodeDepth,
        value: current.value,
      });
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

    if (!addBytes(1)) return { limit: "documentJsonBytes", ok: false };
    stack.push({
      firstProperty: true,
      generalContainerDepth: current.generalContainerDepth,
      iterator: iterateOwnEnumerableStringProperties(current.value),
      kind: "object",
      nodeDepth: current.nodeDepth,
    });
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
  if (error instanceof RequestBodyTooLargeError) {
    return documentResourceLimitResponse();
  }
  if (error instanceof OperationTimeoutError) {
    return NextResponse.json({ error: "Operation timed out" }, { status: 504 });
  }
  return null;
}

export function requestExceedsDocumentBodyLimit(request: Request) {
  const contentLength = request.headers?.get("content-length");
  return contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > DOCUMENT_REQUEST_BODY_BYTES;
}

/**
 * Read a Web Request body without trusting Content-Length. The stream is cancelled
 * as soon as the actual byte count crosses the configured in-memory boundary.
 */
export async function readBoundedRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Body limit must be a non-negative integer");
  const declaredLength = request.headers?.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new RequestBodyTooLargeError();
        await Promise.resolve(reader.cancel(error)).catch(() => undefined);
        throw error;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function parseBoundedJson(request: Request, maxBytes = DOCUMENT_REQUEST_BODY_BYTES): Promise<unknown> {
  const bytes = await readBoundedRequestBytes(request, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function parseBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBoundedRequestBytes(request, maxBytes);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Request(request.url || "http://localhost", {
    body,
    headers: request.headers,
    method: "POST",
  }).formData();
}

export function documentResourceLimitResponse() {
  return NextResponse.json({ error: "Document exceeds resource limits" }, { status: 413 });
}

function isNode(value: unknown): value is Record<string, unknown> & { type: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function* iterateOwnEnumerableStringProperties(
  value: object,
): Generator<readonly [string, unknown], void> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield [key, (value as Record<string, unknown>)[key]] as const;
  }
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
