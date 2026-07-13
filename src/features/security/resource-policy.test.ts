// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  RequestBodyTooLargeError,
  OperationTimeoutError,
  RESOURCE_LIMITS,
  parseBoundedFormData,
  parseBoundedJson,
  readBoundedRequestBytes,
  requestExceedsDocumentBodyLimit,
  validateTiptapResource,
  withOperationTimeout,
} from "./resource-policy";

function createNestedAttrs(depth: number): Record<string, unknown> {
  let attrs: Record<string, unknown> = { leaf: true };
  for (let currentDepth = 1; currentDepth < depth; currentDepth += 1) {
    attrs = { nested: attrs };
  }
  return attrs;
}

function createTiptapNodeChain(
  depth: number,
  deepestAttrs?: Record<string, unknown>,
): Record<string, unknown> {
  if (depth < 1) throw new Error("Node depth must be positive");
  if (depth === 1) return { ...(deepestAttrs ? { attrs: deepestAttrs } : {}), type: "doc" };

  let child: Record<string, unknown> = {
    ...(deepestAttrs ? { attrs: deepestAttrs } : {}),
    text: "leaf",
    type: "text",
  };
  for (let nodeDepth = depth; nodeDepth > 2; nodeDepth -= 1) {
    child = { content: [child], type: "paragraph" };
  }
  return { content: [child], type: "doc" };
}

describe("resource policy", () => {
  it("defines the required conservative resource limits", () => {
    expect(RESOURCE_LIMITS).toEqual({
      docxBytes: 10 * 1024 * 1024,
      documentJsonBytes: 10 * 1024 * 1024,
      documentDepth: 64,
      documentNodes: 100_000,
      operationMs: 30_000,
      proposalBatchItems: 100,
    });
  });

  it("rejects a shallow document whose text exceeds the complete JSON byte budget", () => {
    const hugeText = "x".repeat(20 * 1024 * 1024);

    expect(
      validateTiptapResource({
        type: "doc",
        content: [{ type: "text", text: hugeText }],
      }),
    ).toEqual({ limit: "documentJsonBytes", ok: false });
  });

  it("counts attrs, marks, keys, and scalar values toward the byte budget", () => {
    expect(
      validateTiptapResource(
        {
          type: "doc",
          attrs: { massiveAttribute: "x".repeat(2_000) },
          content: [{ type: "text", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }],
        },
        { documentDepth: 64, documentJsonBytes: 1_000, documentNodes: 100_000 },
      ),
    ).toEqual({ limit: "documentJsonBytes", ok: false });
  });

  it("matches JSON.stringify byte boundaries for Unicode and enumerable own string properties", () => {
    const attrs = Object.create(null) as Record<PropertyKey, unknown>;
    attrs['quoted"key'] = "emoji 😀 and lone surrogate \ud800";
    attrs.control = "line\nfeed";
    attrs[Symbol("ignored")] = "not serialized";
    Object.defineProperty(attrs, "hidden", { enumerable: false, value: "not serialized" });
    const document = { attrs, content: [], type: "doc" };
    const exactBytes = Buffer.byteLength(JSON.stringify(document));

    expect(
      validateTiptapResource(document, {
        documentDepth: 64,
        documentJsonBytes: exactBytes,
        documentNodes: 100_000,
      }),
    ).toEqual({ depth: 1, nodes: 1, ok: true });
    expect(
      validateTiptapResource(document, {
        documentDepth: 64,
        documentJsonBytes: exactBytes - 1,
        documentNodes: 100_000,
      }),
    ).toEqual({ limit: "documentJsonBytes", ok: false });
  });

  it("allows bounded JSON envelope overhead in Content-Length prechecks", () => {
    const request = new Request("http://localhost", {
      headers: { "content-length": String(RESOURCE_LIMITS.documentJsonBytes + 1024) },
    });

    expect(requestExceedsDocumentBodyLimit(request)).toBe(false);
  });

  it("counts streamed bytes when Content-Length is missing or falsely small", async () => {
    for (const headers of [undefined, { "content-length": "1" }]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("5678"));
          controller.close();
        },
      });
      const request = new Request("http://localhost", {
        body,
        // Node's Request requires duplex for a streaming request body.
        // @ts-expect-error Node-specific RequestInit extension
        duplex: "half",
        headers,
        method: "POST",
      });

      await expect(readBoundedRequestBytes(request, 7)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    }
  });

  it("cancels a chunked request stream immediately after its byte budget is exceeded", async () => {
    const cancel = vi.fn();
    const request = {
      body: {
        getReader: () => ({
          cancel,
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([4, 5, 6]) }),
          releaseLock: vi.fn(),
        }),
      },
      headers: new Headers(),
    } as unknown as Request;

    await expect(readBoundedRequestBytes(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("parses a bounded JSON stream without trusting Content-Length", async () => {
    const request = new Request("http://localhost", {
      body: JSON.stringify({ title: "Bounded" }),
      headers: { "content-length": "1" },
      method: "POST",
    });

    await expect(parseBoundedJson(request, 100)).resolves.toEqual({ title: "Bounded" });
  });

  it("rejects production bodyless form adapters without calling their pre-parsed fallback", async () => {
    const formData = vi.fn(async () => new FormData());
    const request = {
      body: null,
      formData,
      headers: new Headers({ "content-type": "multipart/form-data; boundary=unsafe" }),
      url: "http://localhost/api/documents/import",
    } as unknown as Request;
    vi.stubEnv("NODE_ENV", "production");

    try {
      await expect(parseBoundedFormData(request, 1_024)).rejects.toThrow();
      expect(formData).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses a real bounded multipart request through its readable body", async () => {
    const boundary = "----coredot-resource-policy-test";
    const request = new Request("http://localhost/api/documents/import", {
      body:
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="memo.docx"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n" +
        "docx-bytes\r\n" +
        `--${boundary}--\r\n`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      method: "POST",
    });

    const formData = await parseBoundedFormData(request, 1_024);
    const file = formData.get("file") as File;

    expect(file.name).toBe("memo.docx");
    expect(file.size).toBe(10);
  });

  it("counts a valid Tiptap tree deterministically", () => {
    expect(
      validateTiptapResource({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).toEqual({ depth: 3, nodes: 3, ok: true });
  });

  it("short-circuits when node or depth limits are exceeded", () => {
    expect(
      validateTiptapResource(
        { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] },
        { documentDepth: 4, documentNodes: 2 },
      ),
    ).toEqual({ limit: "documentNodes", ok: false });

    expect(
      validateTiptapResource(
        { type: "doc", content: [{ type: "paragraph", content: [{ type: "text" }] }] },
        { documentDepth: 2, documentNodes: 10 },
      ),
    ).toEqual({ limit: "documentDepth", ok: false });
  });

  it("rejects a 600k-node content array before scheduling every child", () => {
    const content = Array.from({ length: 600_000 }, () => ({ type: "paragraph" }));

    expect(validateTiptapResource({ type: "doc", content })).toEqual({
      limit: "documentNodes",
      ok: false,
    });
  });

  it("rejects 600k attrs lazily without reading a late property or snapshotting object entries", () => {
    const attrs = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 600_000; index += 1) {
      attrs[`property_${index}`] = index;
    }
    const readLateProperty = vi.fn(() => "must not be read");
    Object.defineProperty(attrs, "late_property", {
      enumerable: true,
      get: readLateProperty,
    });
    const entries = vi.spyOn(Object, "entries").mockImplementation(() => {
      throw new Error("Object.entries must not be used by resource validation");
    });
    const keys = vi.spyOn(Object, "keys").mockImplementation(() => {
      throw new Error("Object.keys must not be used by resource validation");
    });

    let result: ReturnType<typeof validateTiptapResource>;
    try {
      result = validateTiptapResource(
        { type: "doc", attrs, content: [] },
        { documentDepth: 64, documentJsonBytes: 256, documentNodes: 100_000 },
      );
    } finally {
      entries.mockRestore();
      keys.mockRestore();
    }

    expect(result).toEqual({ limit: "documentJsonBytes", ok: false });
    expect(readLateProperty).not.toHaveBeenCalled();
  });

  it("rejects attrs objects deeper than the container limit before reading the rejected container", () => {
    const readRejectedContainer = vi.fn(() => "must not be read");
    let attrs: Record<string, unknown> = {};
    Object.defineProperty(attrs, "late_property", {
      enumerable: true,
      get: readRejectedContainer,
    });
    for (let depth = 0; depth < 64; depth += 1) {
      attrs = { nested: attrs };
    }

    expect(validateTiptapResource({ type: "doc", attrs })).toEqual({
      limit: "documentDepth",
      ok: false,
    });
    expect(readRejectedContainer).not.toHaveBeenCalled();
  });

  it("rejects attrs arrays deeper than the general JSON container limit", () => {
    let attrs: unknown = { leaf: true };
    for (let depth = 0; depth < 64; depth += 1) {
      attrs = [attrs];
    }

    expect(validateTiptapResource({ type: "doc", attrs })).toEqual({
      limit: "documentDepth",
      ok: false,
    });
  });

  it("accepts attrs containers at the depth limit without changing Tiptap node depth", () => {
    let attrs: unknown = { leaf: true };
    for (let depth = 0; depth < 62; depth += 1) {
      attrs = { nested: attrs };
    }

    expect(validateTiptapResource({ type: "doc", attrs })).toEqual({
      depth: 1,
      nodes: 1,
      ok: true,
    });
  });

  it("allows a 64-node structural chain and rejects the 65th node", () => {
    expect(validateTiptapResource(createTiptapNodeChain(64))).toEqual({
      depth: 64,
      nodes: 64,
      ok: true,
    });
    expect(validateTiptapResource(createTiptapNodeChain(65))).toEqual({
      limit: "documentDepth",
      ok: false,
    });
  });

  it("enforces independent attrs depth at the deepest node of a 64-node chain", () => {
    expect(validateTiptapResource(createTiptapNodeChain(64, createNestedAttrs(64)))).toEqual({
      depth: 64,
      nodes: 64,
      ok: true,
    });
    expect(validateTiptapResource(createTiptapNodeChain(64, createNestedAttrs(65)))).toEqual({
      limit: "documentDepth",
      ok: false,
    });
  });

  it("rejects malformed and cyclic runtime objects without recursing forever", () => {
    const cyclic: { content?: unknown[]; type: string } = { type: "doc" };
    cyclic.content = [cyclic];

    expect(validateTiptapResource(cyclic)).toEqual({ limit: "malformed", ok: false });
    expect(validateTiptapResource({ type: "doc", content: "not-an-array" })).toEqual({
      limit: "malformed",
      ok: false,
    });
    expect(validateTiptapResource({ type: "doc", content: ["not-a-node"] })).toEqual({
      limit: "malformed",
      ok: false,
    });
  });

  it("aborts and rejects with a typed timeout at the configured deadline", async () => {
    vi.useFakeTimers();
    const operation = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    try {
      const pending = withOperationTimeout(operation, 25);
      const rejection = expect(pending).rejects.toBeInstanceOf(OperationTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(operation.mock.calls[0]?.[0].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
