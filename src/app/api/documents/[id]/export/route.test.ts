import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentById } from "@/features/documents/document-repository";
import { tiptapJsonToDocxBuffer } from "@/features/documents/docx-conversion";
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
      title: "Draft",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      plainText: "",
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
      title: "Saved title",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      plainText: "",
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
    expect(tiptapJsonToDocxBuffer).toHaveBeenCalledWith(contentJson, "Unsaved title");
    await expect(response.arrayBuffer()).resolves.toEqual(Buffer.from("docx bytes").buffer);
  });
});
