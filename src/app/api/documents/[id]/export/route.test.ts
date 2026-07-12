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
  tiptapJsonToDocxBuffer: vi.fn(),
}));

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/documents/doc_1/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function createContext(id = "doc_1") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/documents/[id]/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 429 before lookup or body parsing when the budget is exhausted", async () => {
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

  it("rejects an oversized JSON request from Content-Length before parsing or lookup", async () => {
    const json = vi.fn();
    const request = {
      headers: new Headers({ "content-length": String(RESOURCE_LIMITS.documentJsonBytes + 1024 * 1024 + 1) }),
      json,
    } as unknown as Request;

    const response = await POST(request, createContext());

    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("rejects over-deep content before DOCX conversion", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      id: "doc_1",
      workspaceId: "vitest-workspace",
      title: "Draft",
      contentJson: { type: "doc" },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    let deepNode: Record<string, unknown> = { type: "text", text: "deep" };
    for (let depth = 0; depth < RESOURCE_LIMITS.documentDepth; depth += 1) {
      deepNode = { type: "paragraph", content: [deepNode] };
    }

    const response = await POST(
      createJsonRequest({ title: "Deep", contentJson: { type: "doc", content: [deepNode] } }),
      createContext(),
    );

    expect(response.status).toBe(413);
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("returns 504 on conversion timeout without producing export bytes", async () => {
    vi.useFakeTimers();
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      id: "doc_1",
      workspaceId: "vitest-workspace",
      title: "Draft",
      contentJson: { type: "doc" },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.mocked(tiptapJsonToDocxBuffer).mockImplementationOnce(async () => {
      markStarted?.();
      return new Promise<never>(() => undefined);
    });

    try {
      const pending = POST(createJsonRequest({ title: "Slow", contentJson: { type: "doc" } }), createContext());
      await started;
      await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.operationMs);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "Operation timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 404 when the document does not exist", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof getDocumentById>>);

    const response = await POST(
      createJsonRequest({ title: "Draft", contentJson: { type: "doc", content: [{ type: "paragraph" }] } }),
      createContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Document not found" });
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid export payload", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      id: "doc_1",
      workspaceId: "vitest-workspace",
      title: "Draft",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      status: "draft",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(createJsonRequest({ title: "", contentJson: { type: "doc" } }), createContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(tiptapJsonToDocxBuffer).not.toHaveBeenCalled();
  });

  it("exports the submitted draft as a DOCX response", async () => {
    const contentJson = {
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved draft" }] }],
    };
    vi.mocked(getDocumentById).mockResolvedValueOnce({
      id: "doc_1",
      workspaceId: "vitest-workspace",
      title: "Saved title",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      status: "draft",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    vi.mocked(tiptapJsonToDocxBuffer).mockResolvedValueOnce(Buffer.from("docx bytes"));

    const response = await POST(createJsonRequest({ title: "Unsaved title", contentJson }), createContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers.get("Content-Disposition")).toContain('filename="Unsaved title.docx"');
    expect(tiptapJsonToDocxBuffer).toHaveBeenCalledWith(contentJson, "Unsaved title", expect.any(AbortSignal));
    await expect(response.arrayBuffer()).resolves.toEqual(Buffer.from("docx bytes").buffer);
  });
});
