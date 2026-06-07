import { Extension, type Editor } from "@tiptap/react";
import { AllSelection, Plugin, TextSelection, type EditorState } from "@tiptap/pm/state";

type NotionModASelectionRange = {
  from: number;
  mode: "all" | "block";
  to: number;
};

export const NotionModASelection = Extension.create({
  name: "notionModASelection",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      "Mod-a": () => applyNotionModASelection(this.editor),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, event) => {
            if (!isSelectAllShortcut(event)) {
              return false;
            }

            event.preventDefault();
            return applyNotionModASelection(editor);
          },
        },
      }),
    ];
  },
});

function isSelectAllShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "a" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function applyNotionModASelection(editor: Editor) {
  const nextSelection = getNotionModASelectionRange(editor.state);
  if (!nextSelection) {
    return false;
  }

  const selection =
    nextSelection.mode === "all"
      ? new AllSelection(editor.state.doc)
      : TextSelection.create(editor.state.doc, nextSelection.from, nextSelection.to);

  editor.view.dispatch(editor.state.tr.setSelection(selection));
  return true;
}

export function getNotionModASelectionRange(state: EditorState): NotionModASelectionRange | null {
  if (state.selection instanceof AllSelection) {
    return {
      from: 0,
      mode: "all",
      to: state.doc.content.size,
    };
  }

  const resolvedBlock = resolveSelectionTextBlock(state);
  const blockDepth = resolvedBlock.depth;
  if (blockDepth === null) {
    return {
      from: 0,
      mode: "all",
      to: state.doc.content.size,
    };
  }

  const blockFrom = resolvedBlock.$pos.start(blockDepth);
  const blockTo = resolvedBlock.$pos.end(blockDepth);
  if (blockFrom === blockTo) {
    return {
      from: 0,
      mode: "all",
      to: state.doc.content.size,
    };
  }

  const selectionIsInsideBlock =
    resolvedBlock.isBoundaryFallback || (state.selection.from >= blockFrom && state.selection.to <= blockTo);
  if (!selectionIsInsideBlock) {
    return {
      from: 0,
      mode: "all",
      to: state.doc.content.size,
    };
  }

  const selectionAlreadyCoversBlock =
    !resolvedBlock.isBoundaryFallback &&
    !state.selection.empty &&
    state.selection.from === blockFrom &&
    state.selection.to === blockTo;
  if (selectionAlreadyCoversBlock) {
    return {
      from: 0,
      mode: "all",
      to: state.doc.content.size,
    };
  }

  return {
    from: blockFrom,
    mode: "block",
    to: blockTo,
  };
}

type ResolvedPosition = EditorState["selection"]["$from"];

function resolveSelectionTextBlock(state: EditorState): {
  $pos: ResolvedPosition;
  depth: number | null;
  isBoundaryFallback: boolean;
} {
  const currentDepth = findTextBlockDepth(state.selection.$from);
  if (currentDepth !== null) {
    return { $pos: state.selection.$from, depth: currentDepth, isBoundaryFallback: false };
  }

  if (state.selection.empty && state.selection.from > 0) {
    for (let position = state.selection.from - 1; position >= 0; position -= 1) {
      const previousPosition = state.doc.resolve(position);
      const previousDepth = findTextBlockDepth(previousPosition);
      if (previousDepth !== null) {
        return { $pos: previousPosition, depth: previousDepth, isBoundaryFallback: true };
      }
    }
  }

  return { $pos: state.selection.$from, depth: null, isBoundaryFallback: false };
}

function findTextBlockDepth($pos: ResolvedPosition) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).isTextblock) {
      return depth;
    }
  }

  return null;
}
