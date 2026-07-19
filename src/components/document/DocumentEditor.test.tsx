import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Editor } from "@tiptap/react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TiptapJson } from "@/db/schema";
import { createDocumentSchemaExtensions } from "@/features/documents/tiptap-extensions";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { prepareBaseExtensionsForCollaboration } from "@/features/collaboration/client/collaboration-editor-extensions";
import { createYjsFieldStore } from "@/features/collaboration/client/yjs-field-store";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { editorMessages } from "@/features/i18n/editor-language";
import {
  getBlockActionRangeAtPosition,
  getListItemBlockActionRangeByPath,
  getListItemDomPath,
  readBlockGutterPosition,
} from "./editor-block-ranges";
import { isNoopBlockDropTarget } from "./editor-block-drop-targets";
import {
  DocumentEditor,
  getSelectionMenuPosition,
} from "./DocumentEditor";

const editors: Editor[] = [];

describe("DocumentEditor", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    while (editors.length > 0) {
      editors.pop()?.destroy();
    }
  });

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

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Board Brief");
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

  it("renders collaboration body only from Yjs and never resynchronizes it when projected props change", async () => {
    const user = userEvent.setup();
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const sharedDocument = codec.bootstrap({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Canonical Yjs body" }] }],
      },
      metadataJson: {},
      plainText: "Canonical Yjs body",
      title: "Canonical title",
    });
    const provider = { awareness: new Awareness(sharedDocument) };
    const fields = createYjsFieldStore({
      document: sharedDocument,
      projectProfile: getProjectProfile("default"),
      writable: () => true,
    });
    const session = { document: sharedDocument, fields, provider, writable: true };
    const update = vi.fn();
    const mountDynamicSchemaExtension = vi.fn();
    sharedDocument.on("update", update);

    const runPluginCommand = vi.fn();
    const { rerender, unmount } = render(
      <DocumentEditor
        mode={{ kind: "collaboration", session }}
        pluginContributions={{
          tiptapExtensions: [Extension.create({
            name: "dynamicSchemaExtension",
            onCreate: mountDynamicSchemaExtension,
          })],
          toolbarItems: [{ id: "structural-plugin", label: "Structural plugin", run: runPluginCommand }],
        }}
      />,
    );

    expect(await screen.findByText("Canonical Yjs body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실행 취소" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다시 실행" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "텍스트 스타일" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "글머리 기호" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "번호 목록" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "인용문" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "굵게" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Structural plugin" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Structural plugin" }));
    expect(runPluginCommand).not.toHaveBeenCalled();
    expect(mountDynamicSchemaExtension).not.toHaveBeenCalled();
    update.mockClear();
    rerender(<DocumentEditor mode={{ kind: "collaboration", session }} />);

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Canonical title");
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "문서 제목" }), {
      target: { value: "Collaborative title" },
    });
    expect(sharedDocument.getText("title").toString()).toBe("Collaborative title");
    act(() => {
      sharedDocument.transact(() => {
        const title = sharedDocument.getText("title");
        title.delete(0, title.length);
        title.insert(0, "Remote title");
      }, "remote-title-test");
    });
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Remote title");
    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(titleInput);
    expect(titleInput).toHaveValue("");
    expect(sharedDocument.getText("title").toString()).toBe("Remote title");
    expect(titleInput).toBeRequired();
    expect(titleInput).toHaveAttribute("aria-invalid", "true");
    expect(titleInput).toHaveAccessibleDescription(
      "제목은 필수입니다. 빈 제목은 저장되지 않았습니다.",
    );
    act(() => {
      const remoteTitle = sharedDocument.getText("title");
      sharedDocument.transact(() => {
        remoteTitle.delete(0, remoteTitle.length);
        remoteTitle.insert(0, "Remote override");
      }, "remote-title-while-local-empty");
    });
    expect(titleInput).toHaveValue("Remote override");
    act(() => {
      const remoteTitle = sharedDocument.getText("title");
      sharedDocument.transact(() => {
        remoteTitle.delete(0, remoteTitle.length);
        remoteTitle.insert(0, "Remote title");
      }, "remote-title-return-to-draft-base");
    });
    expect(titleInput).toHaveValue("Remote title");
    act(() => {
      const remoteTitle = sharedDocument.getText("title");
      sharedDocument.transact(() => {
        remoteTitle.delete(0, remoteTitle.length);
        remoteTitle.insert(0, "Remote override");
      }, "remote-title-after-draft-reset");
    });
    expect(titleInput).toHaveValue("Remote override");
    await user.clear(titleInput);
    fireEvent.blur(titleInput);
    expect(titleInput).toHaveValue("Remote override");
    await user.clear(titleInput);
    await user.type(titleInput, "Replacement title");
    expect(titleInput).toHaveValue("Replacement title");
    expect(sharedDocument.getText("title").toString()).toBe("Replacement title");
    expect(screen.getByRole("combobox", { name: /AI.*명령/ })).toBeDisabled();
    expect(screen.getByText("Canonical Yjs body")).toBeInTheDocument();
    expect(update).toHaveBeenCalled();

    unmount();
    fields.destroy();
    sharedDocument.destroy();
  });

  it("restores the canonical title immediately when write permission is downgraded during a blank draft", async () => {
    const user = userEvent.setup();
    const sharedDocument = createCollaborationDocumentCodec(getProjectProfile("default")).bootstrap({
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: {},
      plainText: "",
      title: "Canonical title",
    });
    const provider = { awareness: new Awareness(sharedDocument) };
    const fields = createYjsFieldStore({
      document: sharedDocument,
      projectProfile: getProjectProfile("default"),
      writable: () => true,
    });
    const writableSession = { document: sharedDocument, fields, provider, writable: true };
    const { rerender } = render(
      <DocumentEditor
        language="en"
        messages={editorMessages.en.editor}
        mode={{ kind: "collaboration", session: writableSession }}
      />,
    );
    const titleInput = screen.getByRole("textbox", { name: "Document title" });

    await user.clear(titleInput);
    expect(titleInput).toHaveValue("");
    expect(titleInput).toHaveAttribute("aria-invalid", "true");
    expect(titleInput).toHaveAccessibleDescription(
      "A title is required. The blank title was not saved.",
    );

    rerender(
      <DocumentEditor
        language="en"
        messages={editorMessages.en.editor}
        mode={{
          kind: "collaboration",
          session: { ...writableSession, writable: false },
        }}
      />,
    );

    expect(titleInput).toHaveValue("Canonical title");
    expect(titleInput).toHaveAttribute("readonly");
    expect(titleInput).not.toHaveAttribute("aria-invalid", "true");

    rerender(
      <DocumentEditor
        language="en"
        messages={editorMessages.en.editor}
        mode={{ kind: "collaboration", session: writableSession }}
      />,
    );
    expect(titleInput).toHaveValue("Canonical title");
    expect(titleInput).not.toHaveAttribute("readonly");

    provider.awareness.destroy();
    fields.destroy();
    sharedDocument.destroy();
  });

  it("refreshes find results and counts after a remote collaborative transaction", async () => {
    const user = userEvent.setup();
    const sharedDocument = createCollaborationDocumentCodec(getProjectProfile("default")).bootstrap({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Alpha" }] }],
      },
      metadataJson: {},
      plainText: "Alpha",
      title: "Derived UI",
    });
    const remoteDocument = new Y.Doc();
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(sharedDocument));
    const sharedStateVector = Y.encodeStateVector(sharedDocument);
    const remoteEditor = new Editor({
      extensions: [
        ...prepareBaseExtensionsForCollaboration(createDocumentSchemaExtensions()),
        Collaboration.configure({ document: remoteDocument, field: "body" }),
      ],
    });
    editors.push(remoteEditor);
    const provider = { awareness: new Awareness(sharedDocument) };
    const fields = createYjsFieldStore({
      document: sharedDocument,
      projectProfile: getProjectProfile("default"),
      writable: () => true,
    });

    render(
      <DocumentEditor
        isFindOpen
        mode={{
          kind: "collaboration",
          session: { document: sharedDocument, fields, provider, writable: true },
        }}
      />,
    );
    await user.type(screen.getByRole("searchbox", { name: "문서에서 찾기" }), "Remote");
    expect(screen.getByText("일치 없음")).toBeInTheDocument();
    expect(screen.getByText("1 단어")).toBeInTheDocument();
    expect(screen.getByText("5 글자")).toBeInTheDocument();

    remoteEditor.commands.insertContentAt(1, "Remote ");
    await act(async () => {
      Y.applyUpdate(
        sharedDocument,
        Y.encodeStateAsUpdate(remoteDocument, sharedStateVector),
        "remote-derived-ui-test",
      );
    });

    await waitFor(() => {
      expect(screen.getByText("1/1")).toBeInTheDocument();
      expect(screen.getByText("2 단어")).toBeInTheDocument();
      expect(screen.getByText("12 글자")).toBeInTheDocument();
    });

    provider.awareness.destroy();
    fields.destroy();
    sharedDocument.destroy();
    remoteDocument.destroy();
  });

  it("does not expose a mutable plugin context while collaboration permission is read-only", async () => {
    const sharedDocument = createCollaborationDocumentCodec(getProjectProfile("default")).bootstrap({
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "/" }] }],
      },
      metadataJson: {},
      plainText: "/",
      title: "Read-only projection",
    });
    const provider = { awareness: new Awareness(sharedDocument) };
    const fields = createYjsFieldStore({
      document: sharedDocument,
      projectProfile: getProjectProfile("default"),
      writable: () => false,
    });
    const runPluginAction = vi.fn();

    render(
      <DocumentEditor
        mode={{
          kind: "collaboration",
          session: { document: sharedDocument, fields, provider, writable: false },
        }}
        pluginContributions={{
          toolbarItems: [{ id: "write-bypass", label: "Plugin write", run: runPluginAction }],
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Plugin write" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Plugin write" }));
    expect(runPluginAction).not.toHaveBeenCalled();
    const editorBody = screen.getByRole("textbox", { name: "문서 본문" });
    fireEvent.focus(editorBody);
    fireEvent.keyDown(editorBody, { key: "Enter" });
    expect(screen.queryByRole("listbox", { name: "슬래시 명령" })).not.toBeInTheDocument();
    expect(screen.getByText("/")).toBeInTheDocument();
    fields.destroy();
    sharedDocument.destroy();
  });

  it("renders the editor body in a centered writing column", async () => {
    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Full width body" }] }],
        }}
        onChange={() => undefined}
        title="Layout test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    expect(screen.getByRole("toolbar", { name: "문서 편집 도구" })).toBeInTheDocument();
    expect(editorBody.parentElement).toHaveClass("[&_.tiptap]:w-full");
    expect(editorBody.parentElement).toHaveClass("max-w-[54rem]");
    expect(editorBody.parentElement).toHaveClass("mx-auto");
  });

  it("runs a freeform AI command from the bottom command bar against the current block", async () => {
    const user = userEvent.setup();
    const handleSelectionCommand = vi.fn();

    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Revenue retention needs clearer evidence." }],
            },
          ],
        }}
        onChange={() => undefined}
        onSelectionCommand={handleSelectionCommand}
        title="MSA Review"
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "AI 명령" }), "더 계약서답게 정리해줘");
    await user.click(screen.getByRole("button", { name: "AI 요청" }));

    expect(handleSelectionCommand).toHaveBeenCalledWith(
      "더 계약서답게 정리해줘",
      "Revenue retention needs clearer evidence.",
      expect.objectContaining({
        occurrenceIndex: 0,
        selectionRange: expect.objectContaining({
          from: expect.any(Number),
          to: expect.any(Number),
        }),
      }),
    );
  });

  it("can target the whole document from the bottom AI command bar", async () => {
    const user = userEvent.setup();
    const handleSelectionCommand = vi.fn();

    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First clause." }] },
            { type: "paragraph", content: [{ type: "text", text: "Second clause." }] },
          ],
        }}
        onChange={() => undefined}
        onSelectionCommand={handleSelectionCommand}
        title="MSA Review"
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "AI 적용 범위" }), "document");
    await user.type(screen.getByRole("combobox", { name: "AI 명령" }), "전체 문서를 더 공식적으로 다듬어줘");
    await user.click(screen.getByRole("button", { name: "AI 요청" }));

    expect(handleSelectionCommand).toHaveBeenCalledWith(
      "전체 문서를 더 공식적으로 다듬어줘",
      "First clause.\nSecond clause.",
      expect.objectContaining({
        scope: "document",
        selectionRange: expect.objectContaining({
          from: 0,
          to: expect.any(Number),
        }),
      }),
    );
  });

  it("scrolls the active inline AI suggestion into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Company may use Customer Data to improve services." }],
            },
          ],
        }}
        inlineSuggestions={[
          {
            active: true,
            id: "proposal_contract",
            occurrenceIndex: 0,
            source: "review",
            targetText: "Customer Data",
          },
        ]}
        onChange={() => undefined}
        title="MSA Review"
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "uses %s+A to select the current block first, then the whole document",
    async (modifierKey) => {
      render(
        <DocumentEditor
          contentJson={{
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First paragraph." }] },
              { type: "paragraph", content: [{ type: "text", text: "Second paragraph." }] },
            ],
          }}
          onChange={() => undefined}
          title="Selection test"
        />,
      );

      const editor = await screen.findByRole("textbox", { name: "문서 본문" });
      editor.focus();

      fireEvent.keyDown(editor, { code: "KeyA", key: "a", [modifierKey]: true });
      await waitFor(() => {
        expect(window.getSelection()?.toString()).toBe("First paragraph.");
      });

      fireEvent.keyDown(editor, { code: "KeyA", key: "a", [modifierKey]: true });
      await waitFor(() => {
        expect(window.getSelection()?.toString()).toContain("Second paragraph.");
      });
    },
  );

  it("runs selection commands contributed through the plugin layer", async () => {
    const user = userEvent.setup();
    const handleSelectionCommand = vi.fn();

    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Revenue risk needs review." }] }],
        }}
        onChange={() => undefined}
        onSelectionCommand={handleSelectionCommand}
        pluginContributions={{
          selectionCommands: [
            {
              ariaLabel: "법률 리스크 완화",
              command: "Mitigate legal risk",
              icon: "sparkles",
              id: "plugin.legal_risk",
              label: "리스크",
            },
          ],
        }}
        title="Plugin command test"
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "문서 본문" });
    editor.focus();
    fireEvent.keyDown(editor, { code: "KeyA", key: "a", metaKey: true });

    await user.click(await screen.findByRole("button", { name: "법률 리스크 완화" }));

    expect(handleSelectionCommand).toHaveBeenCalledWith(
      "Mitigate legal risk",
      "Revenue risk needs review.",
      expect.objectContaining({ scope: "selection" }),
      undefined,
      expect.objectContaining({ defaultApplyMode: "replace", id: "plugin.legal_risk" }),
    );
  });

  it("renders and runs plugin toolbar items with the live editor context", async () => {
    const user = userEvent.setup();
    const run = vi.fn();

    render(
      <DocumentEditor
        contentJson={{ type: "doc", content: [{ type: "paragraph" }] }}
        onChange={() => undefined}
        pluginContributions={{
          toolbarItems: [{ id: "plugin.toolbar", label: "Plugin toolbar action", run }],
        }}
        title="Plugin toolbar test"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin toolbar action" }));

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        editor: expect.objectContaining({ commands: expect.any(Object) }),
        language: "ko",
      }),
    );
  });

  it("isolates a failed toolbar contribution without logging its thrown value", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const healthyRun = vi.fn();

    render(
      <DocumentEditor
        contentJson={{ type: "doc", content: [{ type: "paragraph" }] }}
        onChange={() => undefined}
        pluginContributions={{
          toolbarItems: [
            {
              id: "plugin.broken-toolbar",
              label: "Broken toolbar action",
              run: () => {
                throw new Error("private document contents");
              },
            },
            { id: "plugin.healthy-toolbar", label: "Healthy toolbar action", run: healthyRun },
          ],
        }}
        title="Plugin toolbar isolation test"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Broken toolbar action" }));
    await user.click(screen.getByRole("button", { name: "Healthy toolbar action" }));

    expect(healthyRun).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("Editor plugin contribution failed.", {
      contributionId: "plugin.broken-toolbar",
      contributionType: "toolbarItem",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private document contents");
    consoleError.mockRestore();
  });

  it("uses plugin-provided labels in pinned running selection status", async () => {
    render(
      <DocumentEditor
        contentJson={{
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Revenue risk needs review." }] }],
        }}
        onChange={() => undefined}
        pluginContributions={{
          selectionCommands: [
            {
              ariaLabel: "법률 리스크 완화",
              command: "Mitigate legal risk",
              icon: "sparkles",
              id: "plugin.legal_risk",
              label: "리스크",
            },
          ],
        }}
        runningSelectionCommands={[
          {
            anchor: { left: 16, side: "bottom", top: 16 },
            command: "Mitigate legal risk",
            id: "running-plugin-command",
          },
        ]}
        title="Plugin command status test"
      />,
    );

    expect(await screen.findByRole("status", { name: "AI 명령 진행 상태" })).toHaveTextContent(
      "법률 리스크 완화 실행 중...",
    );
  });

  it("keeps the full nested list item path for caret-based block controls", () => {
    const editor = createNestedListEditor();
    const nestedRange = findTextRange(editor, "3");

    const blockRange = getBlockActionRangeAtPosition(editor, nestedRange.from);

    expect(blockRange).toMatchObject({
      kind: "listItem",
      listItemPath: [0, 0, 0, 0, 0],
    });
  });

  it("resolves caret, explicit range, and DOM paths into the second nested list", () => {
    const editor = createMultipleNestedListsEditor();
    const secondListTextRange = findTextRange(editor, "Ordered child");

    const caretRange = getBlockActionRangeAtPosition(editor, secondListTextRange.from);
    const explicitRange = getListItemBlockActionRangeByPath(editor, 0, [0, 1, 0]);

    expect(caretRange).toMatchObject({
      kind: "listItem",
      listItemPath: [0, 1, 0],
      node: expect.objectContaining({ textContent: "Ordered child" }),
    });
    expect(explicitRange).toMatchObject({
      kind: "listItem",
      listItemPath: [0, 1, 0],
      node: expect.objectContaining({ textContent: "Ordered child" }),
    });

    const topLevelList = document.createElement("ul");
    const parentItem = createListItem("Parent", { top: 40 });
    const firstNestedList = document.createElement("ul");
    const secondNestedList = document.createElement("ol");
    const firstChild = createListItem("Bullet child", { top: 80 });
    const secondChild = createListItem("Ordered child", { top: 120 });
    firstNestedList.append(firstChild);
    secondNestedList.append(secondChild);
    parentItem.append(firstNestedList, secondNestedList);
    topLevelList.append(parentItem);

    expect(getListItemDomPath(topLevelList, firstChild)).toEqual([0, 0, 0]);
    expect(getListItemDomPath(topLevelList, secondChild)).toEqual([0, 1, 0]);
  });

  it("anchors nested list gutter controls from the path target instead of a stale nodeDOM result", () => {
    const frame = document.createElement("div");
    mockElementMetrics(frame, { bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800 });
    Object.defineProperty(frame, "clientWidth", { value: 800 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });

    const topLevelList = document.createElement("ul");
    const parentItem = createListItem("1", { top: 40 });
    const nestedList = document.createElement("ul");
    const staleItem = createListItem("3", { top: 120 });
    const targetNestedList = document.createElement("ul");
    const targetItem = createListItem("4", { top: 220 });
    targetNestedList.append(targetItem);
    staleItem.append(targetNestedList);
    nestedList.append(staleItem);
    parentItem.append(nestedList);
    topLevelList.append(parentItem);

    const editor = {
      state: {
        doc: {
          content: { size: 100 },
        },
      },
      view: {
        coordsAtPos: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
        dom: {
          children: {
            item: (index: number) => (index === 0 ? topLevelList : null),
          },
        },
        nodeDOM: () => staleItem,
      },
    };

    const position = readBlockGutterPosition(editor as never, frame, {
      from: 10,
      kind: "listItem",
      listItemIndex: 0,
      listItemPath: [0, 0, 0, 0, 0],
      node: {} as never,
      to: 12,
      topLevelIndex: 0,
    });

    expect(position?.top).toBe(218);
  });

  it("keeps shallow block gutter controls attached to the active line when left gutter space is tight", () => {
    const frame = document.createElement("div");
    mockElementMetrics(frame, { bottom: 600, height: 600, left: 0, right: 400, top: 0, width: 400 });
    Object.defineProperty(frame, "clientWidth", { value: 400 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });

    const paragraph = document.createElement("p");
    mockElementMetrics(paragraph, { bottom: 228, height: 28, left: 64, right: 360, top: 200, width: 296 });

    const editor = {
      state: {
        doc: {
          content: { size: 100 },
        },
      },
      view: {
        coordsAtPos: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
        dom: {
          children: {
            item: (index: number) => (index === 0 ? paragraph : null),
          },
        },
      },
    };

    const position = readBlockGutterPosition(editor as never, frame, {
      from: 0,
      kind: "topLevel",
      node: {} as never,
      to: 2,
      topLevelIndex: 0,
    });

    expect(position).toMatchObject({
      left: 0,
      top: 198,
    });
  });

  it("places block gutter controls on the right when a narrow layout has no safe left margin", () => {
    const frame = document.createElement("div");
    mockElementMetrics(frame, { bottom: 600, height: 600, left: 0, right: 400, top: 0, width: 400 });
    Object.defineProperty(frame, "clientWidth", { value: 400 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });

    const paragraph = document.createElement("p");
    mockElementMetrics(paragraph, { bottom: 228, height: 28, left: 16, right: 384, top: 200, width: 368 });

    const editor = {
      state: {
        doc: {
          content: { size: 100 },
        },
      },
      view: {
        coordsAtPos: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
        dom: {
          children: {
            item: (index: number) => (index === 0 ? paragraph : null),
          },
        },
      },
    };

    const position = readBlockGutterPosition(editor as never, frame, {
      from: 0,
      kind: "topLevel",
      node: {} as never,
      to: 2,
      topLevelIndex: 0,
    });

    expect(position).toMatchObject({
      left: 334,
      top: 198,
    });
  });

  it("moves a deeply nested list item to the shown ancestor-list drop slot", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createDeeplyNestedListDocument()}
        onChange={handleChange}
        title="Nested drag test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedDeepListMetrics(editorBody);

    const sourceParagraph = screen.getByText("4");
    fireEvent.mouseMove(sourceParagraph, { clientX: 270, clientY: 232 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 232, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 275, clientY: 376, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 275, clientY: 232, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0])).toEqual(["3", "2", "5", "4"]);
    expect(readListItemsAtPath(latestChange.contentJson, [0, 0])).toEqual([]);
  });

  it("moves a nested parent list item downward below its next sibling", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createDeeplyNestedListDocument()}
        onChange={handleChange}
        title="Nested parent drag down test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedDeepListMetrics(editorBody);

    const sourceParagraph = screen.getByText("3");
    fireEvent.mouseMove(sourceParagraph, { clientX: 230, clientY: 176 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 176, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 230, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 230, clientY: 320, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0])).toEqual(["2", "3", "5"]);
    expect(readListItemsAtPath(latestChange.contentJson, [0, 1])).toEqual(["4"]);
  });

  it("preserves the editor viewport after a nested list item drop", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createDeeplyNestedListDocument()}
        onChange={handleChange}
        title="Nested drag scroll test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 320;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(editorBody, "focus", {
      configurable: true,
      value: () => {
        scrollTop = 900;
      },
    });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedDeepListMetrics(editorBody);

    const sourceParagraph = screen.getByText("4");
    fireEvent.mouseMove(sourceParagraph, { clientX: 270, clientY: 232 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 232, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 275, clientY: 376, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 275, clientY: 376, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    expect(scrollTop).toBe(320);
  });

  it("does not show a list drop slot inside the dragged item's own descendants", async () => {
    render(
      <DocumentEditor
        contentJson={createNestedListItemWithChildrenDocument()}
        onChange={() => undefined}
        title="Invalid nested drag target test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedNestedListItemWithChildrenMetrics(editorBody);

    const sourceParagraph = screen.getByText("4");
    fireEvent.mouseMove(sourceParagraph, { clientX: 270, clientY: 232 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 232, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 275, clientY: 336, pointerId: 1 });

    expect(frame.querySelector("[data-block-drop-indicator='true']")).not.toBeInTheDocument();
  });

  it("moves a nested list item with children downward below a sibling at the same level", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createNestedListItemWithChildrenAndSiblingDocument()}
        onChange={handleChange}
        title="Nested parent with sibling drag down test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 760, height: 760, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 760, height: 760, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedNestedListItemWithChildrenAndSiblingMetrics(editorBody);

    const sourceParagraph = screen.getByText("4");
    fireEvent.mouseMove(sourceParagraph, { clientX: 230, clientY: 236 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 236, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 230, clientY: 432, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 230, clientY: 432, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0])).toEqual(["6", "4"]);
    expect(readListItemsAtPath(latestChange.contentJson, [0, 1])).toEqual(["2", "5"]);
  });

  it("moves a leaf item downward inside a list nested in another list item", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createNestedListItemWithChildrenDocument()}
        onChange={handleChange}
        title="Nested leaf drag down test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedNestedListItemWithChildrenMetrics(editorBody);

    const sourceParagraph = screen.getAllByText("2")[0]!;
    fireEvent.mouseMove(sourceParagraph, { clientX: 270, clientY: 306 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 160, clientY: 306, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 270, clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 270, clientY: 360, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0, 0])).toEqual(["5", "2"]);
  });

  it("moves a deeply nested leaf item downward inside the same deepest list", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createBrowserLikeDeepNestedListDocument()}
        onChange={handleChange}
        title="Browser-like nested leaf drag down test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 900, height: 900, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 900, height: 900, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedBrowserLikeDeepNestedListMetrics(editorBody);

    const sourceParagraph = screen.getAllByText("2")[0]!;
    fireEvent.mouseMove(sourceParagraph, { clientX: 224, clientY: 572 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 169, clientY: 572, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 224, clientY: 624, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 224, clientY: 624, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0, 0, 1, 1, 0])).toEqual(["5", "2"]);
  });

  it("keeps a deep nested downward drop in the source parent list when the pointer is below the last nested sibling", async () => {
    const handleChange = vi.fn();

    render(
      <DocumentEditor
        contentJson={createBrowserLikeDeepNestedListDocument()}
        onChange={handleChange}
        title="Deep nested list lower edge drag test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 900, height: 900, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 900, height: 900, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedBrowserLikeDeepNestedListMetrics(editorBody);

    const sourceParagraph = screen.getAllByText("2")[0]!;
    fireEvent.mouseMove(sourceParagraph, { clientX: 224, clientY: 572 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 169, clientY: 572, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 224, clientY: 632, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 224, clientY: 632, pointerId: 1 });

    await waitFor(() => {
      expect(handleChange).toHaveBeenCalled();
    });
    const latestChange = handleChange.mock.calls.at(-1)?.[0];
    expect(readListItemsAtPath(latestChange.contentJson, [0, 0, 1, 1, 0])).toEqual(["5", "2"]);
    expect(readListItemsAtPath(latestChange.contentJson, [])).toEqual(["반갑습니다"]);
  });

  it("does not show a list drop slot when dropping back into the same source slot", async () => {
    render(
      <DocumentEditor
        contentJson={createFlatListDocument(["1", "2", "3"])}
        onChange={() => undefined}
        title="Same slot drag target test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });

    mockRenderedFlatListMetrics(editorBody);

    const sourceParagraph = screen.getByText("2");
    fireEvent.mouseMove(sourceParagraph, { clientX: 200, clientY: 176 });

    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 120, clientY: 176, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 120, clientY: 188, pointerId: 1 });

    expect(frame.querySelector("[data-block-drop-indicator='true']")).not.toBeInTheDocument();
  });

  it("classifies same-slot list drops as no-op targets", () => {
    const source = {
      from: 1,
      kind: "listItem" as const,
      listItemIndex: 1,
      listItemPath: [1],
      node: {} as never,
      to: 2,
      topLevelIndex: 0,
    };

    expect(
      isNoopBlockDropTarget(source, {
        dropIndex: 1,
        indicator: { left: 0, top: 0, width: 100 },
        kind: "listItem",
        listItemPath: [],
        topLevelIndex: 0,
      }),
    ).toBe(true);

    expect(
      isNoopBlockDropTarget(source, {
        dropIndex: 3,
        indicator: { left: 0, top: 0, width: 100 },
        kind: "listItem",
        listItemPath: [],
        topLevelIndex: 0,
      }),
    ).toBe(false);
  });

  it("shows a lightweight block drag preview while dragging", async () => {
    render(
      <DocumentEditor
        contentJson={createFlatListDocument(["1", "2", "3"])}
        onChange={() => undefined}
        title="Drag preview test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });
    mockRenderedFlatListMetrics(editorBody);

    fireEvent.mouseMove(screen.getByText("2"), { clientX: 200, clientY: 176 });
    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 120, clientY: 176, pointerId: 1 });
    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 140, clientY: 220, pointerId: 1 });

    expect(screen.getByRole("status", { name: "블록 이동 미리보기" })).toHaveTextContent("2");

    fireEvent.pointerUp(dragHandle, { clientX: 140, clientY: 220, pointerId: 1 });

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "블록 이동 미리보기" })).not.toBeInTheDocument();
    });
  });

  it("cancels a block drop when the live editor document changed during dragging", async () => {
    const handleChange = vi.fn();

    const { rerender } = render(
      <DocumentEditor
        contentJson={createFlatListDocument(["1", "2", "3"])}
        onChange={handleChange}
        title="Stale drag test"
      />,
    );

    const editorBody = await screen.findByRole("textbox", { name: "문서 본문" });
    const frame = editorBody.closest(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(frame, "clientWidth", { value: 900 });
    Object.defineProperty(frame, "scrollTop", { value: 0 });
    mockElementMetrics(frame, { bottom: 700, height: 700, left: 0, right: 900, top: 0, width: 900 });
    mockElementMetrics(editorBody, { bottom: 700, height: 700, left: 100, right: 800, top: 0, width: 700 });
    mockRenderedFlatListMetrics(editorBody);

    fireEvent.mouseMove(screen.getByText("2"), { clientX: 200, clientY: 176 });
    const dragHandle = await screen.findByRole("button", { name: "블록 메뉴 열기" });
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 120, clientY: 176, pointerId: 1 });
    rerender(
      <DocumentEditor
        contentJson={createFlatListDocument(["1", "changed", "3"])}
        onChange={handleChange}
        title="Stale drag test"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("changed")).toBeInTheDocument();
    });
    handleChange.mockClear();

    fireEvent.pointerMove(dragHandle, { buttons: 1, clientX: 120, clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(dragHandle, { clientX: 120, clientY: 240, pointerId: 1 });

    expect(handleChange).not.toHaveBeenCalled();
  });

  it("positions the selection toolbar below text near the top of the editor", () => {
    const position = getSelectionMenuPosition({
      frameRect: { height: 520, left: 200, top: 120, width: 720 },
      scrollTop: 0,
      selectedText: "Top line selection",
      selectionEnd: { bottom: 166, left: 380, right: 460, top: 142 },
      selectionStart: { bottom: 164, left: 260, right: 360, top: 140 },
    });

    expect(position.side).toBe("bottom");
    expect(position.top).toBeGreaterThan(46);
  });

  it("keeps the selection toolbar below a wrapped top selection", () => {
    const position = getSelectionMenuPosition({
      frameRect: { height: 520, left: 200, top: 120, width: 720 },
      scrollTop: 0,
      selectedText: "Wrapped selection",
      selectionEnd: { bottom: 190, left: 380, right: 460, top: 166 },
      selectionStart: { bottom: 164, left: 260, right: 360, top: 140 },
    });

    expect(position.side).toBe("bottom");
    expect(position.top).toBeGreaterThan(70);
    expect(position.top).toBeLessThan(100);
  });

  it("positions the selection toolbar above text when there is room", () => {
    const position = getSelectionMenuPosition({
      frameRect: { height: 520, left: 200, top: 120, width: 720 },
      scrollTop: 0,
      selectedText: "Middle selection",
      selectionEnd: { bottom: 446, left: 380, right: 460, top: 422 },
      selectionStart: { bottom: 444, left: 260, right: 360, top: 420 },
    });

    expect(position.side).toBe("top");
    expect(position.top).toBeLessThan(300);
  });
});

function createNestedListEditor() {
  const editor = new Editor({
    content: {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "반갑습니다" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "하하하" }] },
                        {
                          type: "bulletList",
                          content: [
                            {
                              type: "listItem",
                              content: [{ type: "paragraph", content: [{ type: "text", text: "3" }] }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    extensions: createDocumentSchemaExtensions(),
  });
  editors.push(editor);
  return editor;
}

function createMultipleNestedListsEditor() {
  const editor = new Editor({
    content: {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet child" }] }],
                    },
                  ],
                },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Ordered child" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    extensions: createDocumentSchemaExtensions(),
  });
  editors.push(editor);
  return editor;
}

function createDeeplyNestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "1" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "3" }] },
                      {
                        type: "bulletList",
                        content: [
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "4" }] }],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "5" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createNestedListItemWithChildrenDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "1" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "4" }] },
                      {
                        type: "bulletList",
                        content: [
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                          },
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "5" }] }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createNestedListItemWithChildrenAndSiblingDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "1" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "4" }] },
                      {
                        type: "bulletList",
                        content: [
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                          },
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "5" }] }],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "6" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createBrowserLikeDeepNestedListDocument(): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "반갑습니다" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "하하하" }] },
                      {
                        type: "bulletList",
                        content: [
                          {
                            type: "listItem",
                            content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
                          },
                          {
                            type: "listItem",
                            content: [
                              { type: "paragraph", content: [{ type: "text", text: "51" }] },
                              {
                                type: "bulletList",
                                content: [
                                  {
                                    type: "listItem",
                                    content: [{ type: "paragraph", content: [{ type: "text", text: "3" }] }],
                                  },
                                  {
                                    type: "listItem",
                                    content: [
                                      { type: "paragraph", content: [{ type: "text", text: "3" }] },
                                      {
                                        type: "bulletList",
                                        content: [
                                          {
                                            type: "listItem",
                                            content: [
                                              { type: "paragraph", content: [{ type: "text", text: "4" }] },
                                              {
                                                type: "bulletList",
                                                content: [
                                                  {
                                                    type: "listItem",
                                                    content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                                                  },
                                                  {
                                                    type: "listItem",
                                                    content: [{ type: "paragraph", content: [{ type: "text", text: "5" }] }],
                                                  },
                                                ],
                                              },
                                            ],
                                          },
                                        ],
                                      },
                                    ],
                                  },
                                  {
                                    type: "listItem",
                                    content: [
                                      { type: "paragraph", content: [{ type: "text", text: "4" }] },
                                      {
                                        type: "bulletList",
                                        content: [
                                          {
                                            type: "listItem",
                                            content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
                                          },
                                        ],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createFlatListDocument(items: string[]): TiptapJson {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: items.map((text) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      },
    ],
  };
}

function mockRenderedDeepListMetrics(editorBody: HTMLElement) {
  const rootList = editorBody.querySelector("ul");
  const listItems = Array.from(editorBody.querySelectorAll("li"));
  const paragraphs = Array.from(editorBody.querySelectorAll("p"));
  if (!rootList) {
    throw new Error("Root list not found");
  }

  mockElementMetrics(rootList, { bottom: 410, height: 340, left: 140, right: 780, top: 70, width: 640 });
  const paragraphRectsByText = new Map([
    ["1", { top: 100, left: 170 }],
    ["3", { top: 160, left: 210 }],
    ["4", { top: 220, left: 250 }],
    ["2", { top: 290, left: 210 }],
    ["5", { top: 350, left: 210 }],
  ]);
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent ?? "";
    const rect = paragraphRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(paragraph, {
      bottom: rect.top + 32,
      height: 32,
      left: rect.left,
      right: rect.left + 80,
      top: rect.top,
      width: 80,
    });
  }

  const itemRectsByText = new Map([
    ["1", { bottom: 410, left: 140, top: 100 }],
    ["3", { bottom: 260, left: 180, top: 160 }],
    ["4", { bottom: 252, left: 220, top: 220 }],
    ["2", { bottom: 322, left: 180, top: 290 }],
    ["5", { bottom: 382, left: 180, top: 350 }],
  ]);
  for (const listItem of listItems) {
    const text = listItem.querySelector("p")?.textContent ?? "";
    const rect = itemRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(listItem, {
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: 760,
      top: rect.top,
      width: 760 - rect.left,
    });
  }
}

function mockRenderedNestedListItemWithChildrenMetrics(editorBody: HTMLElement) {
  const rootList = editorBody.querySelector("ul");
  const listItems = Array.from(editorBody.querySelectorAll("li"));
  const paragraphs = Array.from(editorBody.querySelectorAll("p"));
  if (!rootList) {
    throw new Error("Root list not found");
  }

  mockElementMetrics(rootList, { bottom: 370, height: 300, left: 140, right: 780, top: 70, width: 640 });
  const paragraphRectsByText = new Map([
    ["1", { top: 100, left: 170 }],
    ["4", { top: 220, left: 210 }],
    ["2", { top: 290, left: 250 }],
    ["5", { top: 330, left: 250 }],
  ]);
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent ?? "";
    const rect = paragraphRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(paragraph, {
      bottom: rect.top + 32,
      height: 32,
      left: rect.left,
      right: rect.left + 80,
      top: rect.top,
      width: 80,
    });
  }

  const itemRectsByText = new Map([
    ["1", { bottom: 370, left: 140, top: 100 }],
    ["4", { bottom: 362, left: 180, top: 220 }],
    ["2", { bottom: 322, left: 220, top: 290 }],
    ["5", { bottom: 362, left: 220, top: 330 }],
  ]);
  for (const listItem of listItems) {
    const text = listItem.querySelector("p")?.textContent ?? "";
    const rect = itemRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(listItem, {
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: 760,
      top: rect.top,
      width: 760 - rect.left,
    });
  }
}

function mockRenderedNestedListItemWithChildrenAndSiblingMetrics(editorBody: HTMLElement) {
  const rootList = editorBody.querySelector("ul");
  const listItems = Array.from(editorBody.querySelectorAll("li"));
  const paragraphs = Array.from(editorBody.querySelectorAll("p"));
  if (!rootList) {
    throw new Error("Root list not found");
  }

  mockElementMetrics(rootList, { bottom: 470, height: 400, left: 140, right: 780, top: 70, width: 640 });
  const paragraphRectsByText = new Map([
    ["1", { top: 100, left: 170 }],
    ["4", { top: 220, left: 210 }],
    ["2", { top: 290, left: 250 }],
    ["5", { top: 330, left: 250 }],
    ["6", { top: 400, left: 210 }],
  ]);
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent ?? "";
    const rect = paragraphRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(paragraph, {
      bottom: rect.top + 32,
      height: 32,
      left: rect.left,
      right: rect.left + 80,
      top: rect.top,
      width: 80,
    });
  }

  const itemRectsByText = new Map([
    ["1", { bottom: 432, left: 140, top: 100 }],
    ["4", { bottom: 362, left: 180, top: 220 }],
    ["2", { bottom: 322, left: 220, top: 290 }],
    ["5", { bottom: 362, left: 220, top: 330 }],
    ["6", { bottom: 432, left: 180, top: 400 }],
  ]);
  for (const listItem of listItems) {
    const text = listItem.querySelector("p")?.textContent ?? "";
    const rect = itemRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(listItem, {
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: 760,
      top: rect.top,
      width: 760 - rect.left,
    });
  }
}

function mockRenderedBrowserLikeDeepNestedListMetrics(editorBody: HTMLElement) {
  const rootList = editorBody.querySelector("ul");
  const listItems = Array.from(editorBody.querySelectorAll("li"));
  const paragraphs = Array.from(editorBody.querySelectorAll("p"));
  if (!rootList) {
    throw new Error("Root list not found");
  }

  mockElementMetrics(rootList, { bottom: 760, height: 640, left: 80, right: 780, top: 120, width: 700 });
  const paragraphRectsByIndex = [
    { left: 88, text: "반갑습니다", top: 278 },
    { left: 112, text: "하하하", top: 318 },
    { left: 136, text: "1", top: 358 },
    { left: 136, text: "51", top: 398 },
    { left: 160, text: "3", top: 438 },
    { left: 160, text: "3", top: 478 },
    { left: 184, text: "4", top: 518 },
    { left: 208, text: "2", top: 558 },
    { left: 208, text: "5", top: 598 },
    { left: 160, text: "4", top: 638 },
    { left: 184, text: "2", top: 678 },
  ];

  paragraphs.forEach((paragraph, index) => {
    const rect = paragraphRectsByIndex[index];
    if (!rect) return;
    expect(paragraph.textContent).toBe(rect.text);

    mockElementMetrics(paragraph, {
      bottom: rect.top + 28,
      height: 28,
      left: rect.left,
      right: 766,
      top: rect.top,
      width: 766 - rect.left,
    });
  });

  const itemRectsByIndex = [
    { bottom: 706, left: 88, top: 278 },
    { bottom: 706, left: 112, top: 318 },
    { bottom: 386, left: 136, top: 358 },
    { bottom: 706, left: 136, top: 398 },
    { bottom: 466, left: 160, top: 438 },
    { bottom: 626, left: 160, top: 478 },
    { bottom: 626, left: 184, top: 518 },
    { bottom: 586, left: 208, top: 558 },
    { bottom: 626, left: 208, top: 598 },
    { bottom: 706, left: 160, top: 638 },
    { bottom: 706, left: 184, top: 678 },
  ];
  listItems.forEach((listItem, index) => {
    const rect = itemRectsByIndex[index];
    if (!rect) return;

    mockElementMetrics(listItem, {
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: 766,
      top: rect.top,
      width: 766 - rect.left,
    });
  });
}

function mockRenderedFlatListMetrics(editorBody: HTMLElement) {
  const rootList = editorBody.querySelector("ul");
  const listItems = Array.from(editorBody.querySelectorAll("li"));
  const paragraphs = Array.from(editorBody.querySelectorAll("p"));
  if (!rootList) {
    throw new Error("Root list not found");
  }

  mockElementMetrics(rootList, { bottom: 230, height: 150, left: 140, right: 780, top: 80, width: 640 });
  const paragraphRectsByText = new Map([
    ["1", { top: 100, left: 170 }],
    ["2", { top: 160, left: 170 }],
    ["3", { top: 220, left: 170 }],
  ]);
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent ?? "";
    const rect = paragraphRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(paragraph, {
      bottom: rect.top + 32,
      height: 32,
      left: rect.left,
      right: rect.left + 80,
      top: rect.top,
      width: 80,
    });
  }

  const itemRectsByText = new Map([
    ["1", { bottom: 132, left: 140, top: 100 }],
    ["2", { bottom: 192, left: 140, top: 160 }],
    ["3", { bottom: 252, left: 140, top: 220 }],
  ]);
  for (const listItem of listItems) {
    const text = listItem.querySelector("p")?.textContent ?? "";
    const rect = itemRectsByText.get(text);
    if (!rect) continue;

    mockElementMetrics(listItem, {
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: 760,
      top: rect.top,
      width: 760 - rect.left,
    });
  }
}

function readListItemsAtPath(contentJson: { content?: unknown[] }, parentPath: number[]) {
  let listNode = contentJson.content?.[0] as { content?: unknown[] } | undefined;

  for (const itemIndex of parentPath) {
    const listItem = listNode?.content?.[itemIndex] as { content?: unknown[] } | undefined;
    listNode = listItem?.content?.find((child) => {
      const type = (child as { type?: string }).type;
      return type === "bulletList" || type === "orderedList" || type === "taskList";
    }) as { content?: unknown[] } | undefined;
  }

  return ((listNode?.content ?? []) as Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }>).map(
    (item) => item.content?.[0]?.content?.[0]?.text ?? "",
  );
}

function findTextRange(editor: Editor, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText || !node.text) return true;

    const offset = node.text.indexOf(text);
    if (offset === -1) return true;

    found = { from: pos + offset, to: pos + offset + text.length };
    return false;
  });

  if (!found) {
    throw new Error(`Text not found: ${text}`);
  }

  return found;
}

function createListItem(text: string, rect: { top: number }) {
  const listItem = document.createElement("li");
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  listItem.append(paragraph);

  mockElementMetrics(paragraph, {
    bottom: rect.top + 32,
    height: 32,
    left: 360,
    right: 420,
    top: rect.top,
    width: 60,
  });
  mockElementMetrics(listItem, {
    bottom: rect.top + 32,
    height: 32,
    left: 320,
    right: 500,
    top: rect.top,
    width: 180,
  });

  return listItem;
}

type TestRect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

function mockElementMetrics(element: HTMLElement, rect: TestRect) {
  element.getBoundingClientRect = () =>
    ({
      bottom: rect.bottom ?? 0,
      height: rect.height ?? 0,
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      top: rect.top ?? 0,
      width: rect.width ?? 0,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}
