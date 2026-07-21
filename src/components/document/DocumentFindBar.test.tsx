import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentFindBar } from "./DocumentFindBar";

const messages = {
  caseSensitive: "대소문자 구분",
  close: "찾기 닫기",
  currentMatch: "{current}/{total}",
  findLabel: "문서에서 찾기",
  findPlaceholder: "찾을 텍스트",
  next: "다음",
  noMatches: "일치 없음",
  previous: "이전",
  regex: "정규식",
  replace: "교체",
  replaceAll: "모두 교체",
  replaceCurrent: "현재 교체",
  replaceLabel: "교체할 텍스트",
  replacePlaceholder: "교체 텍스트",
};

describe("DocumentFindBar", () => {
  it("focuses the search input when it opens", () => {
    render(
      <DocumentFindBar
        activeIndex={0}
        caseSensitive={false}
        error={null}
        matchCount={0}
        messages={messages}
        onCaseSensitiveChange={vi.fn()}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onQueryChange={vi.fn()}
        onRegexChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={vi.fn()}
        onReplaceTextChange={vi.fn()}
        query=""
        regex={false}
        replaceText=""
      />,
    );

    expect(screen.getByRole("searchbox", { name: "문서에서 찾기" })).toHaveFocus();
  });

  it("renders query input, match count, and navigation controls", () => {
    const onQueryChange = vi.fn();

    render(
      <DocumentFindBar
        activeIndex={1}
        caseSensitive={false}
        error={null}
        matchCount={3}
        messages={messages}
        onCaseSensitiveChange={vi.fn()}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onQueryChange={onQueryChange}
        onRegexChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={vi.fn()}
        onReplaceTextChange={vi.fn()}
        query=""
        regex={false}
        replaceText=""
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "문서에서 찾기" }), { target: { value: "매출" } });

    expect(onQueryChange).toHaveBeenLastCalledWith("매출");
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "이전" })).toBeEnabled();
  });

  it("disables replace actions when there are no matches", () => {
    render(
      <DocumentFindBar
        activeIndex={0}
        caseSensitive={false}
        error={null}
        matchCount={0}
        messages={messages}
        onCaseSensitiveChange={vi.fn()}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onQueryChange={vi.fn()}
        onRegexChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={vi.fn()}
        onReplaceTextChange={vi.fn()}
        query="없음"
        regex={false}
        replaceText=""
      />,
    );

    expect(screen.getByText("일치 없음")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "현재 교체" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "모두 교체" })).toBeDisabled();
  });

  it("keeps search available but disables replacement controls when read-only", () => {
    render(
      <DocumentFindBar
        activeIndex={0}
        caseSensitive={false}
        error={null}
        matchCount={2}
        messages={messages}
        onCaseSensitiveChange={vi.fn()}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onQueryChange={vi.fn()}
        onRegexChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={vi.fn()}
        onReplaceTextChange={vi.fn()}
        query="revenue"
        readOnly
        regex={false}
        replaceText=""
      />,
    );

    expect(screen.getByRole("searchbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "현재 교체" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "모두 교체" })).toBeDisabled();
  });

  it("toggles options and submits replace actions", () => {
    const onCaseSensitiveChange = vi.fn();
    const onRegexChange = vi.fn();
    const onReplaceCurrent = vi.fn();
    const onReplaceAll = vi.fn();

    render(
      <DocumentFindBar
        activeIndex={0}
        caseSensitive={false}
        error={null}
        matchCount={1}
        messages={messages}
        onCaseSensitiveChange={onCaseSensitiveChange}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onQueryChange={vi.fn()}
        onRegexChange={onRegexChange}
        onReplaceAll={onReplaceAll}
        onReplaceCurrent={onReplaceCurrent}
        onReplaceTextChange={vi.fn()}
        query="Revenue"
        regex={false}
        replaceText="매출"
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "대소문자 구분" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "정규식" }));
    fireEvent.click(screen.getByRole("button", { name: "현재 교체" }));
    fireEvent.click(screen.getByRole("button", { name: "모두 교체" }));

    expect(onCaseSensitiveChange).toHaveBeenCalledWith(true);
    expect(onRegexChange).toHaveBeenCalledWith(true);
    expect(onReplaceCurrent).toHaveBeenCalledTimes(1);
    expect(onReplaceAll).toHaveBeenCalledTimes(1);
  });
});
