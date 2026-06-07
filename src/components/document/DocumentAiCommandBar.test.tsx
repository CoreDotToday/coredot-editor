import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentAiCommandBar } from "./DocumentAiCommandBar";

describe("DocumentAiCommandBar", () => {
  it("explains why the command input is disabled when there is no target", () => {
    render(
      <DocumentAiCommandBar
        disabled
        language="ko"
        onSubmit={() => undefined}
        scope="document"
      />,
    );

    expect(screen.getByRole("textbox", { name: "AI 명령" })).toHaveAttribute(
      "placeholder",
      "먼저 문서 내용을 작성하거나 텍스트를 선택하세요.",
    );
  });
});
