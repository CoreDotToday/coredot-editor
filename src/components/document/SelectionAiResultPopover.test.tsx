import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionAiResultPopover } from "./SelectionAiResultPopover";

const result = {
  anchor: { left: 24, side: "bottom" as const, top: 64 },
  command: "Translate to Korean",
  defaultApplyMode: "insert_below" as const,
  explanation: "AI rewrite suggestion.",
  proposalId: "proposal_1",
  replacementText: "매출 유지율은 더 명확한 근거가 필요합니다.",
  targetText: "Revenue retention needs clearer evidence.",
};

describe("SelectionAiResultPopover", () => {
  it("shows original and suggested text before the user applies a result", () => {
    render(
      <SelectionAiResultPopover
        onApply={() => undefined}
        onDismiss={() => undefined}
        result={result}
      />,
    );

    const region = screen.getByRole("region", { name: "선택 AI 결과" });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("원문")).toBeInTheDocument();
    expect(screen.getByText("Revenue retention needs clearer evidence.")).toBeInTheDocument();
    expect(screen.getByText("제안")).toBeInTheDocument();
    expect(screen.getByText("매출 유지율은 더 명확한 근거가 필요합니다.")).toBeInTheDocument();
  });

  it("localizes the visible command label", () => {
    render(
      <SelectionAiResultPopover
        language="ko"
        onApply={() => undefined}
        onDismiss={() => undefined}
        result={result}
      />,
    );

    expect(screen.getByText("한국어로 번역")).toBeInTheDocument();
    expect(screen.queryByText("Translate to Korean")).not.toBeInTheDocument();
  });

  it("sends the selected apply mode from the preview actions", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    render(<SelectionAiResultPopover onApply={onApply} onDismiss={() => undefined} result={result} />);

    await user.click(screen.getByRole("button", { name: "교체" }));
    await user.click(screen.getByRole("button", { name: "아래에 추가" }));

    expect(onApply).toHaveBeenNthCalledWith(1, "proposal_1", "replace");
    expect(onApply).toHaveBeenNthCalledWith(2, "proposal_1", "insert_below");
  });

  it("clamps the popover inside the visible editor frame", () => {
    const frame = document.createElement("div");
    Object.defineProperty(frame, "clientHeight", { value: 360 });
    Object.defineProperty(frame, "clientWidth", { value: 640 });
    Object.defineProperty(frame, "scrollTop", { value: 720 });

    render(
      <SelectionAiResultPopover
        frame={frame}
        onApply={() => undefined}
        onDismiss={() => undefined}
        result={{
          ...result,
          anchor: { left: 900, side: "bottom", top: 1400 },
          replacementText: "긴 제안\n".repeat(80),
        }}
      />,
    );

    const region = screen.getByRole("region", { name: "선택 AI 결과" });
    expect(region).toHaveStyle({ left: "176px", maxHeight: "328px", top: "736px", width: "448px" });
  });
});
