import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentById } from "@/features/documents/document-repository";
import { tiptapJsonToDocxBuffer } from "@/features/documents/docx-conversion";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  getDocumentById: vi.fn(),
}));

vi.mock("@/features/documents/docx-conversion", () => ({
  docxBufferToTiptapJson: vi.fn(),
  tiptapJsonToDocxBuffer: vi.fn(),
}));

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/documents/doc_1/export/preview", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

function createContext(id = "doc_1") {
  return { params: Promise.resolve({ id }) };
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
  const request = new Request("http://localhost/api/documents/doc_1/export/preview", {
    body,
    // @ts-expect-error Node-specific RequestInit extension
    duplex: "half",
    method: "POST",
    signal,
  });
  return { cancel, read, request };
}

function mockDocument() {
  vi.mocked(getDocumentById).mockResolvedValueOnce({
    id: "doc_1",
    workspaceId: "vitest-workspace",
    creationKey: null,
    title: "Draft",
    contentJson: { type: "doc" },
    metadataJson: {},
    plainText: "",
    readiness: "draft",
    revision: 0,
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("POST /api/documents/[id]/export/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 429 before lookup or parsing when the budget is exhausted", async () => {
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 20,
        remaining: 0,
        retryAt: new Date(Date.now() + 5_000),
      })),
    });
    const request = { json: vi.fn() } as unknown as Request;

    const response = await POST(request, createContext());

    expect(response.status).toBe(429);
    expect(request.json).not.toHaveBeenCalled();
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("consumes the dedicated export-preview budget", async () => {
    const consume = vi.fn(async () => ({
      allowed: true,
      limit: 20,
      remaining: 19,
      retryAt: new Date(Date.now() + 60_000),
    }));
    setRequestBudgetForTests({ consume });
    mockDocument();

    const response = await POST(createJsonRequest({ contentJson: { type: "doc" } }), createContext());

    expect(response.status).toBe(200);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ policyId: "documents.export-preview" }));
  });

  it("rejects an oversized request before lookup or parsing", async () => {
    const request = {
      headers: new Headers({ "content-length": String(RESOURCE_LIMITS.documentJsonBytes + 1024 * 1024 + 1) }),
      json: vi.fn(),
    } as unknown as Request;

    const response = await POST(request, createContext());

    expect(response.status).toBe(413);
    expect(request.json).not.toHaveBeenCalled();
    expect(getDocumentById).not.toHaveBeenCalled();
  });

  it("previews table fidelity from the submitted draft without converting", async () => {
    mockDocument();
    const contentJson = {
      type: "doc" as const,
      content: [{
        type: "table",
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text: "셀" }] }],
          }],
        }],
      }],
    };

    const response = await POST(createJsonRequest({ contentJson }), createContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fidelity: {
        items: expect.arrayContaining([{ feature: "table", outcome: "approximated" }]),
        requiresAcknowledgement: true,
      },
    });
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("returns 504 and cancels a stalled chunked preview body", async () => {
    vi.useFakeTimers();
    mockDocument();
    const stalled = createStalledRequest();
    try {
      const pending = POST(stalled.request, createContext());
      await vi.waitFor(() => expect(stalled.read).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);

      const response = await pending;
      expect(response.status).toBe(504);
      expect(stalled.cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 408 and cancels an aborted chunked preview body", async () => {
    mockDocument();
    const controller = new AbortController();
    const stalled = createStalledRequest(controller.signal);
    const pending = POST(stalled.request, createContext());
    await vi.waitFor(() => expect(stalled.read).toHaveBeenCalledTimes(1));

    controller.abort();

    const response = await pending;
    expect(response.status).toBe(408);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the workspace document does not exist", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof getDocumentById>>);

    const response = await POST(createJsonRequest({ contentJson: { type: "doc" } }), createContext("missing"));

    expect(response.status).toBe(404);
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });
});
