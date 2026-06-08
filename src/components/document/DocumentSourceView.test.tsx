import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorMessages } from "@/features/i18n/editor-language";
import { DocumentSourceView } from "./DocumentSourceView";

const messages = editorMessages.ko.sourceView;

const contentJson = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "source body" }] }],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("DocumentSourceView", () => {
  it("renders source text, pretty JSON, and a validation status", () => {
    render(<DocumentSourceView contentJson={contentJson} messages={messages} title="Source Memo" />);

    const region = screen.getByRole("region", { name: "문서 Source" });
    expect(region).toHaveTextContent("source body");
    expect(region).toHaveTextContent('"type": "doc"');
    expect(screen.getByRole("status", { name: "JSON 유효" })).toBeInTheDocument();
  });

  it("copies plain text and JSON source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<DocumentSourceView contentJson={contentJson} messages={messages} title="Source Memo" />);

    fireEvent.click(screen.getByRole("button", { name: "일반 텍스트 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("source body"));
    expect(screen.getByText("복사됨")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "JSON 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"type": "doc"')));
  });

  it("downloads the JSON source snapshot", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    render(<DocumentSourceView contentJson={contentJson} messages={messages} title="Source Memo" />);

    fireEvent.click(screen.getByRole("button", { name: "JSON 다운로드" }));

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:source");
  });
});
