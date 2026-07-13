import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentImportButton } from "./DocumentImportButton";
import { DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS } from "@/features/documents/document-interchange-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DocumentImportButton", () => {
  it.each([
    {
      dialogName: "가져오기 결과 확인",
      inputName: "DOCX 파일 선택",
      labels: ["목록: 유지됨", "표: 유지됨", "줄바꿈: 유지됨", "코드 블록: 유지됨"],
      language: "ko" as const,
      unsupported: /지원되지 않는 형식/,
    },
    {
      dialogName: "Review import result",
      inputName: "Choose DOCX file",
      labels: ["List: Preserved", "Table: Preserved", "Line break: Preserved", "Code block: Preserved"],
      language: "en" as const,
      unsupported: /Unsupported feature/,
    },
  ])("renders canonical supported import features in $language without unsupported labels", async ({
    dialogName,
    inputName,
    labels,
    language,
    unsupported,
  }) => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      preview: { title: "memo", contentJson: { type: "doc", content: [{ type: "paragraph" }] } },
      fidelity: {
        items: [
          { feature: "list", outcome: "preserved" },
          { feature: "table", outcome: "preserved" },
          { feature: "hard-break", outcome: "preserved" },
          { feature: "code-block", outcome: "preserved" },
        ],
        requiresAcknowledgement: false,
      },
      warnings: [],
    })));
    render(<DocumentImportButton language={language} onImported={vi.fn()} />);

    await user.upload(
      screen.getByLabelText(inputName),
      new File([new Uint8Array([1])], "memo.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    expect(await screen.findByRole("dialog", { name: dialogName })).toBeInTheDocument();
    for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(unsupported)).not.toBeInTheDocument();
  });

  it("shows fidelity and warnings before explicitly continuing to the imported document", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preview: {
          title: "memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        },
        fidelity: {
          items: [
            { feature: "paragraph", outcome: "preserved" },
            { feature: "table", outcome: "approximated" },
          ],
          requiresAcknowledgement: true,
        },
        warnings: ["Unsupported image was ignored"],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_imported" } }), { status: 201 }));

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
    expect(await screen.findByRole("dialog", { name: "가져오기 결과 확인" })).toBeInTheDocument();
    expect(screen.getByText("Unsupported image was ignored")).toBeInTheDocument();
    expect(screen.getByText(/표.*유사하게 변환됨/)).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "가져온 문서 열기" }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/documents/import",
      expect.objectContaining({
        body: JSON.stringify({
          action: "confirm",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
          title: "memo",
        }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Idempotency-Key": expect.any(String),
        }),
        method: "POST",
      }),
    );
    expect(onImported).toHaveBeenCalledWith("doc_imported");
  });

  it("traps modal focus, closes on Escape, and restores the import trigger", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        preview: {
          title: "memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        },
        fidelity: {
          items: [{ feature: "paragraph", outcome: "preserved" }],
          requiresAcknowledgement: false,
        },
        warnings: [],
      }), { status: 201 }),
    );
    const { container } = render(<DocumentImportButton onImported={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "DOCX 가져오기" });

    await user.upload(
      screen.getByLabelText("DOCX 파일 선택"),
      new File([new Uint8Array([1])], "memo.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    expect(await screen.findByRole("dialog", { name: "가져오기 결과 확인" })).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "취소" });
    const confirm = screen.getByRole("button", { name: "가져온 문서 열기" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "가져오기 결과 확인" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmation failures inside the review dialog and retries with the same creation key", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preview: {
          title: "memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        },
        fidelity: {
          items: [{ feature: "docx-formatting", outcome: "approximated" }],
          requiresAcknowledgement: true,
        },
        warnings: [],
      })))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_imported" } }), { status: 201 }));

    render(<DocumentImportButton onImported={onImported} />);
    await user.upload(
      screen.getByLabelText("DOCX 파일 선택"),
      new File([new Uint8Array([1])], "memo.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: "가져오기 결과 확인" });
    await user.click(screen.getByRole("button", { name: "가져온 문서 열기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("DOCX를 가져오지 못했습니다.");
    expect(dialog).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
    const firstCreationKey = (fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"];

    await user.click(screen.getByRole("button", { name: "가져오기 다시 시도" }));

    const retryCreationKey = (fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>)["Idempotency-Key"];
    expect(retryCreationKey).toBe(firstCreationKey);
    expect(onImported).toHaveBeenCalledWith("doc_imported");
  });

  it("aborts an active preview request on unmount and ignores its late response", async () => {
    let resolveRequest!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return request;
    });
    const onImported = vi.fn();
    const { unmount } = render(<DocumentImportButton onImported={onImported} />);

    fireEvent.change(screen.getByLabelText("DOCX 파일 선택"), {
      target: {
        files: [new File([new Uint8Array([1])], "memo.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })],
      },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    unmount();

    expect(requestSignal?.aborted).toBe(true);
    resolveRequest(new Response(JSON.stringify({
      preview: { title: "late", contentJson: { type: "doc" } },
      fidelity: { items: [], requiresAcknowledgement: true },
      warnings: [],
    })));
    await request;
    expect(onImported).not.toHaveBeenCalled();
  });

  it("ends a stalled preview with a visible error and re-enables importing", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
    render(<DocumentImportButton onImported={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("DOCX 파일 선택"), {
      target: {
        files: [new File([new Uint8Array([1])], "memo.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })],
      },
    });
    expect(screen.getByRole("button", { name: "가져오는 중..." })).toBeDisabled();

    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS));

    expect(screen.getByRole("alert")).toHaveTextContent("DOCX를 가져오지 못했습니다.");
    expect(screen.getByRole("button", { name: "DOCX 가져오기" })).toBeEnabled();
  });

  it("ends a stalled confirmation inside the dialog and allows a stable-key retry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preview: { title: "memo", contentJson: { type: "doc", content: [{ type: "paragraph" }] } },
        fidelity: { items: [{ feature: "docx-formatting", outcome: "approximated" }], requiresAcknowledgement: true },
        warnings: [],
      })))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    render(<DocumentImportButton onImported={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("DOCX 파일 선택"), {
      target: {
        files: [new File([new Uint8Array([1])], "memo.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })],
      },
    });
    expect(await screen.findByRole("dialog", { name: "가져오기 결과 확인" })).toBeInTheDocument();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "가져온 문서 열기" }));
    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS));

    expect(screen.getByRole("dialog", { name: "가져오기 결과 확인" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("DOCX를 가져오지 못했습니다.");
    expect(screen.getByRole("button", { name: "가져오기 다시 시도" })).toBeEnabled();
  });
});
