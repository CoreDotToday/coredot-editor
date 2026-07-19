// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFromDraftIdempotently } from "@/features/documents/document-repository";
import { docxBufferToTiptapJson } from "@/features/documents/docx-conversion";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentFromDraftIdempotently: vi.fn(),
}));

vi.mock("@/features/documents/docx-conversion", () => ({
  docxBufferToTiptapJson: vi.fn(),
  tiptapJsonToDocxBuffer: vi.fn(),
}));

async function createFormRequest(file?: File) {
  const boundary = "----coredot-editor-test-boundary";
  const encoder = new TextEncoder();
  const prefix = file
    ? encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      )
    : new Uint8Array();
  const fileBytes = file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  const suffix = encoder.encode(`${file ? "\r\n" : ""}--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.byteLength + fileBytes.byteLength + suffix.byteLength);
  body.set(prefix, 0);
  body.set(fileBytes, prefix.byteLength);
  body.set(suffix, prefix.byteLength + fileBytes.byteLength);

  return new Request("http://localhost/api/documents/import", {
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    method: "POST",
  });
}

function createStalledRequest(signal = new AbortController().signal) {
  const cancel = vi.fn();
  const read = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel,
    pull: async () => {
      read();
      return new Promise(() => undefined);
    },
  });
  const request = new Request("http://localhost/api/documents/import", {
    body,
    // @ts-expect-error Node-specific RequestInit extension
    duplex: "half",
    method: "POST",
    signal,
  });
  return { cancel, read, request };
}

describe("POST /api/documents/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 429 before parsing multipart data when the budget is exhausted", async () => {
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 10,
        remaining: 0,
        retryAt: new Date(Date.now() + 5_000),
      })),
    });
    const request = { formData: vi.fn(), headers: new Headers() } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(request.formData).not.toHaveBeenCalled();
    expect(docxBufferToTiptapJson).not.toHaveBeenCalled();
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before reading its bytes", async () => {
    const file = new File([new Uint8Array(RESOURCE_LIMITS.docxBytes + 1)], "huge.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const request = await createFormRequest(file);
    const fileArrayBuffer = vi.spyOn(File.prototype, "arrayBuffer");

    try {
      const response = await POST(request);

      expect(response.status).toBe(413);
      expect(fileArrayBuffer).not.toHaveBeenCalled();
      expect(docxBufferToTiptapJson).not.toHaveBeenCalled();
    } finally {
      fileArrayBuffer.mockRestore();
    }
  });

  it("rejects an obviously oversized request from Content-Length before multipart parsing", async () => {
    const formData = vi.fn();
    const request = {
      formData,
      headers: new Headers({ "content-length": String(RESOURCE_LIMITS.docxBytes + 1024 * 1024 + 1) }),
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });

  it("cancels an oversized chunked multipart body when Content-Length is missing", async () => {
    const cancel = vi.fn();
    const request = {
      body: {
        getReader: () => ({
          cancel,
          read: vi.fn().mockResolvedValueOnce({
            done: false,
            value: new Uint8Array(RESOURCE_LIMITS.docxBytes + 1024 * 1024 + 1),
          }),
          releaseLock: vi.fn(),
        }),
      },
      headers: new Headers(),
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(docxBufferToTiptapJson).not.toHaveBeenCalled();
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("returns 504 and cancels a stalled chunked multipart body", async () => {
    vi.useFakeTimers();
    const stalled = createStalledRequest();
    try {
      const pending = POST(stalled.request);
      await vi.waitFor(() => expect(stalled.read).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);

      const response = await pending;
      expect(response.status).toBe(504);
      expect(stalled.cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 408 and cancels an aborted chunked multipart body", async () => {
    const controller = new AbortController();
    const stalled = createStalledRequest(controller.signal);
    const pending = POST(stalled.request);
    await vi.waitFor(() => expect(stalled.read).toHaveBeenCalledTimes(1));

    controller.abort();

    const response = await pending;
    expect(response.status).toBe(408);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects converted content that exceeds the depth policy before persistence", async () => {
    let deepNode: Record<string, unknown> = { type: "text", text: "deep" };
    for (let depth = 0; depth < RESOURCE_LIMITS.documentDepth; depth += 1) {
      deepNode = { type: "paragraph", content: [deepNode] };
    }
    vi.mocked(docxBufferToTiptapJson).mockResolvedValueOnce({
      contentJson: { type: "doc", content: [deepNode] },
      features: [],
      sourceFeatures: [],
      warnings: [],
    });

    const response = await POST(await createFormRequest(new File([new Uint8Array([1])], "deep.docx")));

    expect(response.status).toBe(413);
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("rejects a compressed DOCX whose converted text exceeds the JSON byte budget", async () => {
    vi.mocked(docxBufferToTiptapJson).mockResolvedValueOnce({
      contentJson: {
        type: "doc",
        content: [{ type: "text", text: "x".repeat(RESOURCE_LIMITS.documentJsonBytes + 1) }],
      },
      features: [],
      sourceFeatures: [],
      warnings: [],
    });

    const response = await POST(await createFormRequest(new File([new Uint8Array([1])], "compressed.docx")));

    expect(response.status).toBe(413);
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("returns 504 on conversion timeout without persisting a document", async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.mocked(docxBufferToTiptapJson).mockImplementationOnce(async () => {
      markStarted?.();
      return new Promise<never>(() => undefined);
    });

    try {
      const pending = POST(await createFormRequest(new File([new Uint8Array([1])], "slow.docx")));
      await started;
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "Operation timed out" });
      expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 when the request does not include a DOCX file", async () => {
    const response = await POST(await createFormRequest(new File(["not docx"], "memo.txt", { type: "text/plain" })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "DOCX file is required" });
    expect(docxBufferToTiptapJson).not.toHaveBeenCalled();
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("previews a DOCX conversion without persisting an orphan document", async () => {
    vi.mocked(docxBufferToTiptapJson).mockResolvedValueOnce({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
      },
      features: ["paragraph"],
      sourceFeatures: [],
      warnings: ["Unsupported image was ignored"],
    });
    const response = await POST(
      await createFormRequest(
        new File([new Uint8Array([1, 2, 3])], "Contract Draft.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      preview: {
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
        },
        title: "Contract Draft",
      },
      fidelity: {
        items: expect.arrayContaining([
          { feature: "paragraph", outcome: "preserved" },
          {
            feature: "conversion-warning",
            message: "Unsupported image was ignored",
            outcome: "removed",
          },
        ]),
        requiresAcknowledgement: true,
      },
      warnings: ["Unsupported image was ignored"],
    });
  });

  it("persists a confirmed import idempotently after review", async () => {
    const contentJson = {
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
    };
    vi.mocked(createDocumentFromDraftIdempotently).mockResolvedValueOnce({
      document: {
        id: "doc_imported",
        workspaceId: "vitest-workspace",
        creationKey: "import_1234567890abcdef",
        title: "Contract Draft",
        contentJson,
        metadataJson: {},
        plainText: "Imported body",
        readiness: "draft",
        revision: 0,
        status: "draft",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      replayed: false,
    });
    const request = new Request("http://localhost/api/documents/import", {
      body: JSON.stringify({ action: "confirm", contentJson, title: "Contract Draft" }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "import_1234567890abcdef",
      },
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(createDocumentFromDraftIdempotently).toHaveBeenCalledWith(
      TEST_REQUEST_CONTEXT,
      { contentJson, metadataJson: {}, title: "Contract Draft" },
      "import_1234567890abcdef",
    );
    await expect(response.json()).resolves.toMatchObject({ document: { id: "doc_imported" }, replayed: false });
  });

  it("rejects readiness smuggling during import confirmation", async () => {
    const request = new Request("http://localhost/api/documents/import", {
      body: JSON.stringify({
        action: "confirm",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        readiness: "approved",
        title: "Smuggled import",
      }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "import_1234567890abcdef",
      },
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });
});
