import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { SlashCommandMenu, createSlashCommandItems, filterSlashCommandItems } from "./SlashCommandMenu";

describe("SlashCommandMenu", () => {
  it("filters commands by localized label and aliases", () => {
    const items = createSlashCommandItems("ko");

    expect(filterSlashCommandItems(items, "제목").map((item) => item.id)).toContain("heading_1");
    expect(filterSlashCommandItems(items, "todo").map((item) => item.id)).toContain("task_list");
  });

  it("keeps callback-bound AI slash commands in the compatibility factory", () => {
    const items = createSlashCommandItems("ko", vi.fn());

    expect(items.map((item) => item.id)).toContain("ai_continue");
  });

  it("renders slash commands and applies the selected block command", async () => {
    const user = userEvent.setup();
    const chain = createCommandChain();
    const editorStub = createEditorStub("/h", chain);
    const frame = createFrame();

    render(<SlashCommandMenu editor={editorStub.editor} frameRef={{ current: frame }} language="ko" />);
    act(() => editorStub.emit("transaction"));

    const menu = await screen.findByRole("listbox", { name: "슬래시 명령" });
    await user.click(within(menu).getByRole("option", { name: /제목 1/ }));

    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 1, to: 3 });
    expect(chain.toggleHeading).toHaveBeenCalledWith({ level: 1 });
    expect(chain.run).toHaveBeenCalledTimes(1);
  });

  it("renders externally provided slash commands and isolates execution", async () => {
    const user = userEvent.setup();
    const chain = createCommandChain();
    const command = vi.fn(() => {
      throw new Error("plugin failure");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editorStub = createEditorStub("/p", chain);
    const frame = createFrame();

    render(
      <SlashCommandMenu
        editor={editorStub.editor}
        frameRef={{ current: frame }}
        language="ko"
        slashCommands={[
          {
            aliases: ["plugin"],
            command,
            group: "blocks",
            icon: "sparkles",
            id: "plugin.command",
            label: "Plugin block",
            searchText: "plugin block",
            subtext: "Provided by a plugin",
          },
        ]}
      />,
    );
    act(() => editorStub.emit("transaction"));

    const menu = await screen.findByRole("listbox", { name: "슬래시 명령" });
    await user.click(within(menu).getByRole("option", { name: /Plugin block/ }));

    expect(command).toHaveBeenCalledWith(editorStub.editor, { from: 1, to: 3 });
    expect(consoleError).toHaveBeenCalledWith('Slash command "plugin.command" failed.', expect.any(Error));

    consoleError.mockRestore();
  });

  it("appends callback-bound AI continue when external slash commands are provided", async () => {
    const user = userEvent.setup();
    const chain = createCommandChain();
    const handleAiCommand = vi.fn();
    const editorStub = createEditorStub("/ai", chain);
    const frame = createFrame();

    render(
      <SlashCommandMenu
        editor={editorStub.editor}
        frameRef={{ current: frame }}
        language="ko"
        onAiCommand={handleAiCommand}
        slashCommands={[
          {
            aliases: ["plugin"],
            command: vi.fn(),
            group: "blocks",
            icon: "sparkles",
            id: "plugin.command",
            label: "Plugin block",
            searchText: "plugin block",
            subtext: "Provided by a plugin",
          },
        ]}
      />,
    );
    act(() => editorStub.emit("transaction"));

    const menu = await screen.findByRole("listbox", { name: "슬래시 명령" });
    await user.click(within(menu).getByRole("option", { name: /이어서 쓰기/ }));

    expect(handleAiCommand).toHaveBeenCalledWith("Continue writing");
  });

  it("flips above the cursor near the bottom of the editor frame", async () => {
    const chain = createCommandChain();
    const editorStub = createEditorStub("/h", chain, { bottom: 560, left: 100, top: 540 });
    const frame = createFrame();

    render(<SlashCommandMenu editor={editorStub.editor} frameRef={{ current: frame }} language="ko" />);
    act(() => editorStub.emit("transaction"));

    const menu = await screen.findByRole("listbox", { name: "슬래시 명령" });
    expect(menu).toHaveStyle({ maxHeight: "352px", top: "140px" });
  });
});

function createCommandChain() {
  const chain = {
    deleteRange: vi.fn(() => chain),
    focus: vi.fn(() => chain),
    run: vi.fn(() => true),
    setHorizontalRule: vi.fn(() => chain),
    setParagraph: vi.fn(() => chain),
    toggleBlockquote: vi.fn(() => chain),
    toggleBulletList: vi.fn(() => chain),
    toggleCodeBlock: vi.fn(() => chain),
    toggleHeading: vi.fn(() => chain),
    toggleOrderedList: vi.fn(() => chain),
    toggleTaskList: vi.fn(() => chain),
  };

  return chain;
}

function createEditorStub(
  textBeforeCursor: string,
  chain: ReturnType<typeof createCommandChain>,
  cursorRect: Pick<DOMRect, "bottom" | "left" | "top"> = { bottom: 120, left: 100, top: 100 },
) {
  const listeners = new Map<string, Set<() => void>>();
  const editor = {
    chain: () => chain,
    off: vi.fn((event: string, callback: () => void) => {
      listeners.get(event)?.delete(callback);
    }),
    on: vi.fn((event: string, callback: () => void) => {
      listeners.set(event, new Set([...(listeners.get(event) ?? []), callback]));
    }),
    state: {
      selection: {
        $from: {
          parent: {
            isTextblock: true,
            textBetween: () => textBeforeCursor,
          },
          parentOffset: textBeforeCursor.length,
        },
        empty: true,
        from: 3,
      },
    },
    view: {
      coordsAtPos: () => cursorRect,
      dom: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    },
  };

  return {
    editor: editor as unknown as Editor,
    emit: (event: string) => {
      listeners.get(event)?.forEach((callback) => callback());
    },
  };
}

function createFrame() {
  const frame = document.createElement("div");
  Object.defineProperty(frame, "clientHeight", { value: 600 });
  Object.defineProperty(frame, "clientWidth", { value: 720 });
  Object.defineProperty(frame, "scrollTop", { value: 0 });
  frame.getBoundingClientRect = () =>
    ({
      bottom: 600,
      height: 600,
      left: 80,
      right: 800,
      top: 40,
      width: 720,
      x: 80,
      y: 40,
      toJSON: () => ({}),
    }) as DOMRect;

  return frame;
}
