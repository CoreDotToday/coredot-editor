import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentImportButton } from "./DocumentImportButton";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DocumentImportButton", () => {
  it("uploads a DOCX file and reports the imported document id", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ document: { id: "doc_imported" }, warnings: [] }), { status: 201 }),
    );

    render(<DocumentImportButton onImported={onImported} />);

    await user.upload(
      screen.getByLabelText("DOCX 파일 선택"),
      new File([new Uint8Array([1, 2, 3])], "memo.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/documents/import",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
    expect(onImported).toHaveBeenCalledWith("doc_imported");
  });
});
