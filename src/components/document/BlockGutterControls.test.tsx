import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockGutterControls } from "./BlockGutterControls";

describe("BlockGutterControls", () => {
  it("renders block controls without requiring a text selection", async () => {
    const user = userEvent.setup();
    const handleBlockAction = vi.fn();
    const handleAddBlock = vi.fn();

    render(
      <BlockGutterControls
        isVisible
        left={64}
        onAddBlock={handleAddBlock}
        onBlockAction={handleBlockAction}
        top={88}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "블록 컨트롤" });
    expect(toolbar).toHaveClass("absolute");
    expect(toolbar).toHaveStyle({ left: "64px", top: "88px" });

    await user.click(screen.getByRole("button", { name: "아래에 블록 추가" }));
    expect(handleAddBlock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    await user.click(within(screen.getByRole("menu", { name: "블록 작업" })).getByRole("menuitem", { name: "블록 복제" }));

    expect(handleBlockAction).toHaveBeenCalledWith("duplicate");
  });

  it("does not add a mobile-only upward translate that detaches controls from the active block", () => {
    render(<BlockGutterControls isVisible left={8} top={128} />);

    expect(screen.getByRole("toolbar", { name: "블록 컨트롤" })).not.toHaveClass("max-sm:-translate-y-9");
  });

  it("uses pointer movement for block drag and drop", () => {
    const handleDragStart = vi.fn();
    const handlePointerDragEnd = vi.fn();
    const handlePointerDragMove = vi.fn();

    render(
      <BlockGutterControls
        isVisible
        left={0}
        onBlockDragStart={handleDragStart}
        onBlockPointerDragEnd={handlePointerDragEnd}
        onBlockPointerDragMove={handlePointerDragMove}
        top={0}
      />,
    );

    const dragHandle = screen.getByRole("button", { name: "블록 메뉴 열기" });
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 116, clientY: 132, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 116, clientY: 132, pointerId: 1 });

    expect(handleDragStart).toHaveBeenCalledTimes(1);
    expect(handlePointerDragMove).toHaveBeenCalledWith(expect.objectContaining({ clientX: 116, clientY: 132, deltaX: 16, deltaY: 32 }));
    expect(handlePointerDragEnd).toHaveBeenCalledWith(expect.objectContaining({ clientX: 116, clientY: 132, deltaX: 16, deltaY: 32 }));
  });

  it("moves focus through the block action menu and returns focus on Escape", async () => {
    const user = userEvent.setup();

    render(<BlockGutterControls isVisible left={0} top={0} />);

    const menuButton = screen.getByRole("button", { name: "블록 메뉴 열기" });
    await user.click(menuButton);

    const menu = screen.getByRole("menu", { name: "블록 작업" });
    const menuItems = within(menu).getAllByRole("menuitem");
    expect(menuItems[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(menuItems[1]).toHaveFocus();

    await user.keyboard("{End}");
    expect(menuItems[menuItems.length - 1]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "블록 작업" })).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it("exposes keyboard-accessible block move actions", async () => {
    const user = userEvent.setup();
    const handleBlockAction = vi.fn();

    render(
      <BlockGutterControls
        isVisible
        left={0}
        onBlockAction={handleBlockAction}
        top={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    const menu = screen.getByRole("menu", { name: "블록 작업" });

    await user.click(within(menu).getByRole("menuitem", { name: "블록 위로 이동" }));
    expect(handleBlockAction).toHaveBeenCalledWith("moveUp");

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    await user.click(within(screen.getByRole("menu", { name: "블록 작업" })).getByRole("menuitem", { name: "블록 아래로 이동" }));
    expect(handleBlockAction).toHaveBeenCalledWith("moveDown");
  });

  it("shows list level actions only for list item targets", async () => {
    const user = userEvent.setup();
    const handleBlockAction = vi.fn();
    const { rerender } = render(
      <BlockGutterControls
        isVisible
        isListItem={false}
        left={0}
        onBlockAction={handleBlockAction}
        top={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    expect(within(screen.getByRole("menu", { name: "블록 작업" })).queryByRole("menuitem", { name: "들여쓰기" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("menu", { name: "블록 작업" })).queryByRole("menuitem", { name: "내어쓰기" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    rerender(
      <BlockGutterControls
        isVisible
        isListItem
        left={0}
        onBlockAction={handleBlockAction}
        top={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    const menu = screen.getByRole("menu", { name: "블록 작업" });
    await user.click(within(menu).getByRole("menuitem", { name: "텍스트로 전환" }));
    expect(handleBlockAction).toHaveBeenCalledWith("convertListItemToText");

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    const reopenedMenu = screen.getByRole("menu", { name: "블록 작업" });
    await user.click(within(reopenedMenu).getByRole("menuitem", { name: "들여쓰기" }));
    expect(handleBlockAction).toHaveBeenCalledWith("indentListItem");

    await user.click(screen.getByRole("button", { name: "블록 메뉴 열기" }));
    await user.click(within(screen.getByRole("menu", { name: "블록 작업" })).getByRole("menuitem", { name: "내어쓰기" }));
    expect(handleBlockAction).toHaveBeenCalledWith("outdentListItem");
  });
});
