import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";

describe("DocumentEditor", () => {
  it("updates the title textbox when the title prop changes", () => {
    const { rerender } = render(
      <DocumentEditor
        contentJson={{ type: "doc", content: [{ type: "paragraph" }] }}
        onChange={() => undefined}
        title="Market Entry Memo"
      />,
    );

    rerender(
      <DocumentEditor
        contentJson={{ type: "doc", content: [{ type: "paragraph" }] }}
        onChange={() => undefined}
        title="Board Brief"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Board Brief");
  });

  it("does not call onChange when external content props are applied", () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <DocumentEditor
        contentJson={{ type: "doc", content: [{ type: "paragraph" }] }}
        onChange={handleChange}
        title="Market Entry Memo"
      />,
    );

    rerender(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Updated body" }] }],
        }}
        onChange={handleChange}
        title="Market Entry Memo"
      />,
    );

    expect(handleChange).not.toHaveBeenCalled();
  });
});
