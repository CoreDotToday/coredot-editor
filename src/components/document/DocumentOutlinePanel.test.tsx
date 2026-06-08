import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentOutlinePanel } from "./DocumentOutlinePanel";
import type { DocumentOutlineItem } from "@/features/documents/document-outline";

const messages = {
  empty: "제목을 추가하면 여기에 목차가 표시됩니다.",
  itemLabel: "{title} 위치로 이동",
  title: "개요",
};

function createOutline(children: DocumentOutlineItem[] = []): DocumentOutlineItem {
  return {
    children,
    id: "document-title",
    level: 1,
    title: "문서",
    topLevelIndex: null,
  };
}

describe("DocumentOutlinePanel", () => {
  it("renders nested heading items", () => {
    render(
      <DocumentOutlinePanel
        messages={messages}
        onSelectItem={vi.fn()}
        outline={createOutline([
          {
            children: [
              {
                children: [],
                id: "heading-2",
                level: 2,
                title: "검토 범위",
                topLevelIndex: 2,
              },
            ],
            id: "heading-0",
            level: 1,
            title: "계약 개요",
            topLevelIndex: 0,
          },
        ])}
      />,
    );

    const region = screen.getByRole("navigation", { name: "개요" });
    expect(within(region).getByRole("button", { name: "계약 개요 위치로 이동" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "검토 범위 위치로 이동" })).toBeInTheDocument();
  });

  it("calls onSelectItem with the selected heading", () => {
    const onSelectItem = vi.fn();
    const heading: DocumentOutlineItem = {
      children: [],
      id: "heading-1",
      level: 2,
      title: "위험 요약",
      topLevelIndex: 1,
    };

    render(<DocumentOutlinePanel messages={messages} onSelectItem={onSelectItem} outline={createOutline([heading])} />);

    fireEvent.click(screen.getByRole("button", { name: "위험 요약 위치로 이동" }));

    expect(onSelectItem).toHaveBeenCalledWith(heading);
  });

  it("renders an empty state when no headings exist", () => {
    render(<DocumentOutlinePanel messages={messages} onSelectItem={vi.fn()} outline={createOutline()} />);

    expect(screen.getByText("제목을 추가하면 여기에 목차가 표시됩니다.")).toBeInTheDocument();
  });
});
