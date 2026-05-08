import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentShell } from "./DocumentShell";

describe("DocumentShell", () => {
  it("renders three workspace regions", () => {
    render(
      <DocumentShell
        document={{
          id: "doc_1",
          title: "Market Entry Memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
          plainText: "",
        }}
        templates={[]}
        aiRuns={[]}
      />,
    );

    expect(screen.getByText("Outline")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Market Entry Memo");
    expect(screen.getByText("AI Review")).toBeInTheDocument();
  });
});
