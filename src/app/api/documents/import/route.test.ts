import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFromContent } from "@/features/documents/document-repository";
import { docxBufferToTiptapJson } from "@/features/documents/docx-conversion";
import { POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentFromContent: vi.fn(),
}));

vi.mock("@/features/documents/docx-conversion", () => ({
  docxBufferToTiptapJson: vi.fn(),
}));

function createFormRequest(file?: File) {
  const formData = new FormData();
  if (file) {
    formData.set("file", file);
  }

  return {
    formData: async () => formData,
  } as Request;
}

describe("POST /api/documents/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when the request does not include a DOCX file", async () => {
    const response = await POST(createFormRequest(new File(["not docx"], "memo.txt", { type: "text/plain" })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "DOCX file is required" });
    expect(docxBufferToTiptapJson).not.toHaveBeenCalled();
    expect(createDocumentFromContent).not.toHaveBeenCalled();
  });

  it("imports a DOCX file and creates a document from converted content", async () => {
    vi.mocked(docxBufferToTiptapJson).mockResolvedValueOnce({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
      },
      warnings: ["Unsupported image was ignored"],
    });
    vi.mocked(createDocumentFromContent).mockResolvedValueOnce({
      id: "doc_imported",
      title: "Contract Draft",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
      },
      metadataJson: {},
      plainText: "Imported body",
      readiness: "draft",
      status: "draft",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(
      createFormRequest(
        new File([new Uint8Array([1, 2, 3])], "Contract Draft.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(createDocumentFromContent).toHaveBeenCalledWith("Contract Draft", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Imported body" }] }],
    });
    await expect(response.json()).resolves.toMatchObject({
      document: { id: "doc_imported", title: "Contract Draft" },
      warnings: ["Unsupported image was ignored"],
    });
  });
});
