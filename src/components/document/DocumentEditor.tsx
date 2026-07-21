"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FocusEvent, type MouseEvent } from "react";
import CharacterCount from "@tiptap/extension-character-count";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import {
  Bold,
  Code2,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Quote,
  Redo2,
  Strikethrough,
  Type,
  Undo2,
} from "lucide-react";
import type { TiptapJson } from "@/db/schema";
import {
  createDocumentBlockLocation,
  createDocumentBlockMoveTarget,
  type DocumentBlockDestination,
} from "@/features/documents/block-movement";
import {
  findDocumentMatches,
  nextDocumentFindIndex,
  replaceAllDocumentMatches,
  replaceDocumentMatch,
  type DocumentFindOptions,
} from "@/features/documents/document-find";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import type { AiDocumentReferenceCandidate, ResolvedAiDocumentReference } from "@/features/ai/ai-reference-parser";
import type {
  EditorHostContext,
  EditorPluginContributions,
  EditorSelectionCommand,
  EditorSelectionCommandMetadata,
} from "@/plugins/types";
import { invokeEditorPluginContribution } from "@/plugins/contribution-safety";
import { appDocumentSchemaProfile } from "@/plugins/app-plugins";
import { createCoreDocumentExtensions } from "@/plugins/builtin/core-document-plugin";
import { mergeEditorPluginContributions } from "@/plugins/registry";
import { useEditorPlugins } from "@/plugins/use-editor-plugins";
import { AiSuggestionHighlight, setAiSuggestionHighlights, type AiSuggestionHighlightInput } from "./ai-suggestion-highlight";
import {
  BlockGutterControls,
  type SelectionBlockAction,
  type SelectionBlockDragPoint,
} from "./BlockGutterControls";
import { DocumentAiCommandBar } from "./DocumentAiCommandBar";
import {
  countTextOccurrences,
  type AiCommandScope,
  getEditorAiCommandTarget,
  getEditorAiCommandTargetFromTargets,
  getEditorAiCommandTargets,
} from "./editor-command-targets";
import {
  clamp,
  getBlockActionRangeAtPosition,
  getBlockActionRangeAtViewportY,
  getBlockActionRangeFromDomTarget,
  getListItemBlockActionRangeByPath,
  getTopLevelBlockActionRangeByIndex,
  readBlockGutterPosition,
  type BlockActionRange,
  type BlockGutterState,
  type RuntimeEditor,
} from "./editor-block-ranges";
import {
  getBlockDropTarget,
  type BlockDropIndicator,
  type BlockDropTarget,
} from "./editor-block-drop-targets";
import {
  createEditorBlockDragSession,
  type EditorBlockDragSession,
} from "./editor-block-drag-session";
import {
  applyScopedBlockMove,
  applyScopedLastBlockDeletion,
  applyScopedListItemConversion,
  applyScopedOutdent,
} from "./editor-block-transactions";
import { DocumentFindBar } from "./DocumentFindBar";
import { NotionModASelection } from "./notion-mod-a-selection";
import { SelectionAiMenu } from "./SelectionAiMenu";
import { SelectionAiResultPopover, type SelectionAiResultPreview } from "./SelectionAiResultPopover";
import { SlashCommandMenu } from "./SlashCommandMenu";
import {
  createCollaborationEditorExtensions,
  prepareBaseExtensionsForCollaboration,
  type CollaborationEditorBinding,
} from "@/features/collaboration/client/collaboration-editor-extensions";
import type { YjsFieldStore } from "@/features/collaboration/client/yjs-field-store";
import { COLLABORATION_TITLE_MAX_LENGTH } from "@/features/collaboration/contracts";

type DocumentEditorCommonProps = {
  isFindOpen?: boolean;
  isSelectionCommandRunning?: boolean;
  isSelectionCommandLimitReached?: boolean;
  inlineSuggestions?: AiSuggestionHighlightInput[];
  language?: EditorLanguage;
  messages?: EditorMessages["editor"];
  referenceCandidates?: AiDocumentReferenceCandidate[];
  onFindOpenChange?: (isOpen: boolean) => void;
  onApplySelectionAiResult?: (proposalId: string, applyMode: "replace" | "insert_below") => void;
  onDismissSelectionAiResult?: () => void;
  onRetrySelectionAiResult?: () => void;
  onSelectionCommand?: (
    command: string,
    selectedText: string,
    context: SelectionAiCommandContext,
    references?: ResolvedAiDocumentReference[],
    metadata?: EditorSelectionCommandMetadata,
  ) => void;
  outlineFocusRequest?: { requestId: string; topLevelIndex: number } | null;
  runningSelectionCommand?: string;
  runningSelectionCommandLimit?: number;
  runningSelectionCommands?: RunningSelectionAiCommand[];
  selectionAiResult?: SelectionAiResultPreview | null;
  pluginContributions?: Partial<EditorPluginContributions>;
  resolvedPluginContributions?: EditorPluginContributions;
};

export type DocumentEditorMode =
  | {
      contentJson: TiptapJson;
      kind: "legacy";
      onChange: (draft: { title: string; contentJson: TiptapJson }) => void;
      title: string;
    }
  | {
      kind: "collaboration";
      session: CollaborationEditorBinding & { fields: YjsFieldStore; writable: boolean };
    };

type DocumentEditorProps = DocumentEditorCommonProps & (
  | { mode: DocumentEditorMode }
  | {
      /** Compatibility form for the disabled/legacy editor. */
      contentJson: TiptapJson;
      mode?: undefined;
      onChange: (draft: { title: string; contentJson: TiptapJson }) => void;
      title: string;
    }
);

type SelectionMenuState = {
  blockIndex?: number | null;
  left: number;
  selectedText: string;
  side: SelectionMenuSide;
  top: number;
};

export type RunningSelectionAiCommand = {
  anchor?: SelectionAiAnchor;
  command: string;
  id: string;
};

type SelectionMenuSide = "top" | "bottom";

export type SelectionAiAnchor = {
  left: number;
  side: SelectionMenuSide;
  top: number;
};

export type SelectionAiCommandContext = {
  anchor: SelectionAiAnchor;
  occurrenceIndex: number;
  scope?: AiCommandScope;
  selectionRange: { from: number; to: number };
};

type SelectionRect = Pick<DOMRect, "bottom" | "left" | "right" | "top">;

type SelectionMenuPositionInput = {
  frameRect: Pick<DOMRect, "height" | "left" | "top" | "width">;
  scrollTop: number;
  selectedText: string;
  selectionEnd: SelectionRect;
  selectionStart: SelectionRect;
};

const SELECTION_MENU_GAP = 8;
const SELECTION_MENU_HEIGHT = 84;
const subscribeToNothing = () => () => undefined;

export function DocumentEditor(props: DocumentEditorProps) {
  const {
  inlineSuggestions = [],
  isFindOpen = false,
  isSelectionCommandLimitReached = false,
  isSelectionCommandRunning = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].editor,
  referenceCandidates = [],
  onFindOpenChange,
  onApplySelectionAiResult,
  onDismissSelectionAiResult,
  onRetrySelectionAiResult,
  onSelectionCommand,
  outlineFocusRequest = null,
  pluginContributions,
  resolvedPluginContributions: providedPluginContributions,
  runningSelectionCommand = "",
  runningSelectionCommandLimit = 5,
  runningSelectionCommands = [],
  selectionAiResult = null,
  } = props;
  const mode: DocumentEditorMode = props.mode ?? {
    contentJson: props.contentJson,
    kind: "legacy",
    onChange: props.onChange,
    title: props.title,
  };
  const isLegacyMode = mode.kind === "legacy";
  const collaborationSession = mode.kind === "collaboration" ? mode.session : null;
  const collaborationDocument = collaborationSession?.document ?? null;
  const collaborationProvider = collaborationSession?.provider ?? null;
  const legacyOnChange = mode.kind === "legacy" ? mode.onChange : null;
  const contentJson = isLegacyMode
    ? mode.contentJson
    : ({ type: "doc", content: [{ type: "paragraph" }] } satisfies TiptapJson);
  const collaborationFields = collaborationSession?.fields ?? null;
  const title = useSyncExternalStore(
    collaborationFields?.subscribeTitle ?? subscribeToNothing,
    collaborationFields?.getTitleSnapshot ?? (() => mode.kind === "legacy" ? mode.title : ""),
    collaborationFields?.getTitleSnapshot ?? (() => mode.kind === "legacy" ? mode.title : ""),
  );
  const [collaborationTitleDraft, setCollaborationTitleDraft] = useState<{
    baseTitle: string;
    fields: YjsFieldStore | null;
    value: string;
  }>({ baseTitle: "", fields: null, value: "" });
  const isWritable = isLegacyMode || mode.session.writable;
  let currentCollaborationTitleDraft = collaborationTitleDraft;
  if (
    collaborationFields
    && collaborationTitleDraft.fields === collaborationFields
    && (!isWritable || collaborationTitleDraft.baseTitle !== title)
  ) {
    currentCollaborationTitleDraft = { baseTitle: title, fields: null, value: title };
    setCollaborationTitleDraft(currentCollaborationTitleDraft);
  }
  const displayedTitle = isWritable
    && collaborationFields
    && currentCollaborationTitleDraft.fields === collaborationFields
    && currentCollaborationTitleDraft.baseTitle === title
    ? currentCollaborationTitleDraft.value
    : title;
  const collaborationTitleErrorId = useId();
  const isCollaborationTitleInvalid = !isLegacyMode && displayedTitle.trim().length === 0;
  const canRunAiCommands = onSelectionCommand !== undefined;
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [blockGutter, setBlockGutter] = useState<BlockGutterState | null>(null);
  const [blockDropIndicator, setBlockDropIndicator] = useState<BlockDropIndicator | null>(null);
  const [blockDragPreview, setBlockDragPreview] = useState<{
    left: number;
    text: string;
    top: number;
    type: "listItem" | "topLevel";
  } | null>(null);
  const [editorFrameElement, setEditorFrameElement] = useState<HTMLDivElement | null>(null);
  const [preferredCommandScope, setPreferredCommandScope] = useState<AiCommandScope | null>(null);
  const [findQuery, setFindQuery] = useState("");
  const [findReplaceText, setFindReplaceText] = useState("");
  const [findOptions, setFindOptions] = useState<DocumentFindOptions>({ caseSensitive: false, regex: false });
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const [documentVersion, setDocumentVersion] = useState(0);
  const editorFrameRef = useRef<HTMLDivElement | null>(null);
  const blockGutterTargetRef = useRef<BlockActionRange | null>(null);
  const blockDragSessionRef = useRef<EditorBlockDragSession | null>(null);
  const blockDropTargetRef = useRef<BlockDropTarget | null>(null);
  const titleRef = useRef(title);
  const onChangeRef = useRef<((draft: { title: string; contentJson: TiptapJson }) => void) | null>(
    legacyOnChange,
  );
  const onSelectionCommandRef = useRef(onSelectionCommand);
  const contentJsonSignature = useMemo(
    () => isLegacyMode ? JSON.stringify(contentJson) : "collaboration",
    [contentJson, isLegacyMode],
  );

  useEffect(() => {
    onChangeRef.current = legacyOnChange;
  }, [legacyOnChange]);

  useEffect(() => {
    onSelectionCommandRef.current = onSelectionCommand;
  }, [onSelectionCommand]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const updateBlockGutter = useCallback((nextBlockGutter: BlockGutterState | null) => {
    blockGutterTargetRef.current = nextBlockGutter?.target ?? null;
    setBlockGutter(nextBlockGutter);
  }, []);

  const clearBlockDragState = useCallback(() => {
    blockDragSessionRef.current = null;
    blockDropTargetRef.current = null;
    setBlockDropIndicator(null);
    setBlockDragPreview(null);
  }, []);

  const handleEditorFrameRef = useCallback((element: HTMLDivElement | null) => {
    editorFrameRef.current = element;
    setEditorFrameElement(element);
  }, []);

  const defaultPluginContributions = useEditorPlugins(language, { resolve: !providedPluginContributions });
  const blockControlMessages = editorMessages[language].selectionMenu.blockControls;
  const resolvedPluginContributions = useMemo(
    () => providedPluginContributions ?? mergeEditorPluginContributions(defaultPluginContributions, pluginContributions),
    [defaultPluginContributions, pluginContributions, providedPluginContributions],
  );

  const extensions = useMemo(() => {
    const baseExtensions = isLegacyMode
      ? resolvedPluginContributions.tiptapExtensions
      : prepareBaseExtensionsForCollaboration(
          // Collaborative documents accept only the schema profile that was
          // fingerprinted during session setup. Runtime plugin extensions may
          // still contribute UI, but cannot silently add schema-bearing nodes
          // or marks to a shared body.
          createCoreDocumentExtensions(appDocumentSchemaProfile),
        );
    return [
      ...baseExtensions,
      Placeholder.configure({
        placeholder: messages.placeholder,
      }),
      CharacterCount,
      AiSuggestionHighlight,
      NotionModASelection,
      ...(collaborationDocument && collaborationProvider
        ? createCollaborationEditorExtensions({
            document: collaborationDocument,
            provider: collaborationProvider,
          })
        : []),
    ];
  }, [
    collaborationDocument,
    collaborationProvider,
    isLegacyMode,
    messages.placeholder,
    resolvedPluginContributions.tiptapExtensions,
  ]);

  const editor = useEditor(
    {
      extensions,
      ...(isLegacyMode ? { content: contentJson as JSONContent } : {}),
      editable: isWritable,
      enableInputRules: isLegacyMode,
      editorProps: {
        attributes: {
          "aria-label": messages.bodyLabel,
          "aria-multiline": "true",
          role: "textbox",
        },
      },
      immediatelyRender: false,
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { empty, from, to } = currentEditor.state.selection;
        const blockRange = getCurrentBlockActionRange(currentEditor);

        if (empty) {
          updateBlockGutter(readBlockGutterPosition(currentEditor, editorFrameRef.current, blockRange));
          setSelectionMenu(null);
          return;
        }

        updateBlockGutter(null);
        const selectedText = currentEditor.state.doc.textBetween(from, to, "\n").trim();
        if (!selectedText) {
          setSelectionMenu(null);
          return;
        }

        setSelectionMenu({
          ...readSelectionMenuPosition(currentEditor, editorFrameRef.current, selectedText),
          blockIndex: blockRange?.topLevelIndex ?? null,
        });
      },
      onUpdate: ({ editor: currentEditor }) => {
        setDocumentVersion((currentVersion) => currentVersion + 1);
        onChangeRef.current?.({
          title: titleRef.current,
          contentJson: currentEditor.getJSON() as TiptapJson,
        });
      },
    },
    [extensions, isLegacyMode, messages.bodyLabel, updateBlockGutter],
  );

  useEffect(() => {
    if (!editor || !isLegacyMode) return;

    const editorContentSignature = JSON.stringify(editor.getJSON());
    if (editorContentSignature !== contentJsonSignature) {
      editor.commands.setContent(contentJson as JSONContent, { emitUpdate: false });
    }
  }, [contentJson, contentJsonSignature, editor, isLegacyMode]);

  useEffect(() => {
    if (editor && editor.isEditable !== isWritable) editor.setEditable(isWritable);
  }, [editor, isWritable]);

  useEffect(() => {
    if (!editor) return;

    setAiSuggestionHighlights(editor, inlineSuggestions);
  }, [editor, inlineSuggestions]);

  useEffect(() => {
    if (!editor || !outlineFocusRequest) return;

    const range = getTopLevelBlockActionRangeByIndex(editor, outlineFocusRequest.topLevelIndex);
    if (!range) return;

    focusBlockRange(editor, range);
    requestAnimationFrame(() => {
      const element = editor.view.nodeDOM(range.from) as HTMLElement | null;
      element?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  }, [editor, outlineFocusRequest]);

  useEffect(() => {
    const activeSuggestionId = inlineSuggestions.find((suggestion) => suggestion.active)?.id;
    if (!activeSuggestionId || !editorFrameRef.current) return;

    const timeout = window.setTimeout(() => {
      const activeSuggestionElement = editorFrameRef.current?.querySelector<HTMLElement>(
        `[data-ai-proposal-id="${escapeCssAttributeValue(activeSuggestionId)}"]`,
      );
      activeSuggestionElement?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [inlineSuggestions]);

  const handleTitleChange = useCallback(
    (value: string) => {
      if (!isLegacyMode) {
        if (isWritable) {
          setCollaborationTitleDraft({
            baseTitle: title,
            fields: collaborationFields,
            value,
          });
          try {
            if (collaborationFields?.setTitle(value) === false) {
              setCollaborationTitleDraft({
                baseTitle: title,
                fields: collaborationFields,
                value: title,
              });
            }
          } catch {
            if (value.trim().length > 0) {
              setCollaborationTitleDraft({
                baseTitle: title,
                fields: collaborationFields,
                value: title,
              });
            }
          }
        }
        return;
      }
      titleRef.current = value;
      onChangeRef.current?.({
        title: value,
        contentJson: (editor?.getJSON() as TiptapJson | undefined) ?? contentJson,
      });
    },
    [collaborationFields, contentJson, editor, isLegacyMode, isWritable, title],
  );

  const handleCommand = useCallback(
    (command: string, metadata: EditorSelectionCommandMetadata) => {
      if (!editor) return;

      const { from, to } = editor.state.selection;
      const selectedText = selectionMenu?.selectedText ?? editor.state.doc.textBetween(from, to, "\n").trim();
      if (!selectedText) return;

      const anchor: SelectionAiAnchor = selectionMenu
        ? { left: selectionMenu.left, side: selectionMenu.side, top: selectionMenu.top }
        : { left: 16, side: "bottom", top: 16 };
      const context: SelectionAiCommandContext = {
        anchor,
        occurrenceIndex: countTextOccurrences(editor.state.doc.textBetween(0, from, "\n"), selectedText),
        scope: "selection",
        selectionRange: { from, to },
      };

      onSelectionCommandRef.current?.(command, selectedText, context, undefined, metadata);
    },
    [editor, selectionMenu],
  );

  const handleFreeformCommand = useCallback(
    (command: string, references?: ResolvedAiDocumentReference[]) => {
      if (!editor) return;

      const target = getEditorAiCommandTarget(editor, preferredCommandScope);
      if (!target) return;

      const anchor = readCommandBarResultAnchor(editorFrameRef.current);
      const context = {
        anchor,
        occurrenceIndex: target.occurrenceIndex,
        scope: target.scope,
        selectionRange: target.selectionRange,
      };

      if (references?.length) {
        onSelectionCommandRef.current?.(command, target.selectedText, context, references);
        return;
      }

      onSelectionCommandRef.current?.(command, target.selectedText, context);
    },
    [editor, preferredCommandScope],
  );

  const handleAddBlockBelow = useCallback(() => {
    if (!isWritable) return;
    insertBlockBelow(editor, blockGutter?.target);
  }, [blockGutter?.target, editor, isWritable]);

  const handleBlockAction = useCallback(
    (action: SelectionBlockAction) => {
      if (!editor || !isWritable) return;
      const targetBlock =
        blockGutterTargetRef.current ?? blockGutter?.target ?? getTopLevelBlockActionRangeByIndex(editor, selectionMenu?.blockIndex);

      if (action === "addBelow") {
        insertBlockBelow(editor, targetBlock);
        return;
      }

      if (action === "duplicate") {
        duplicateBlock(editor, targetBlock);
        return;
      }

      if (action === "moveUp" || action === "moveDown") {
        if (!isLegacyMode) return;
        moveBlock(editor, targetBlock, action === "moveUp" ? "up" : "down");
        return;
      }

      if (action === "indentListItem" || action === "outdentListItem") {
        if (!isLegacyMode) return;
        changeListItemLevel(editor, targetBlock, action === "indentListItem" ? "indent" : "outdent");
        return;
      }

      if (action === "convertListItemToText") {
        if (!isLegacyMode) return;
        convertListItemToText(editor, targetBlock);
        return;
      }

      deleteBlock(editor, targetBlock, collaborationDocument);
    },
    [blockGutter?.target, collaborationDocument, editor, isLegacyMode, isWritable, selectionMenu?.blockIndex],
  );

  const handleEditorFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!editor) return;
    if ((event.target as HTMLElement).closest("[data-block-gutter='true']")) return;

    if (!editor.state.selection.empty) {
      updateBlockGutter(null);
      return;
    }

    updateBlockGutter(readBlockGutterPosition(editor, editorFrameRef.current, getCurrentBlockActionRange(editor)));
  }, [editor, updateBlockGutter]);

  const handleEditorMouseMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!editor) return;
      if ((event.target as HTMLElement).closest("[data-block-gutter='true']")) return;
      if (
        blockDragSessionRef.current === null &&
        (!editor.state.selection.empty || hasActiveEditorTextSelection(editor.view.dom))
      ) {
        updateBlockGutter(null);
        return;
      }

      const domBlockRange = getBlockActionRangeFromDomTarget(editor, event.target, event.clientY);
      if (domBlockRange) {
        updateBlockGutter(readBlockGutterPosition(editor, editorFrameRef.current, domBlockRange));
        return;
      }

      const pointBlockRange = getBlockActionRangeAtViewportY(editor, event.clientY);
      if (pointBlockRange) {
        updateBlockGutter(readBlockGutterPosition(editor, editorFrameRef.current, pointBlockRange));
        return;
      }

      let position: { pos: number } | null = null;
      try {
        position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      } catch {
        return;
      }

      if (!position) return;

      const blockRange = getBlockActionRangeAtPosition(editor, position.pos);
      updateBlockGutter(readBlockGutterPosition(editor, editorFrameRef.current, blockRange));
    },
    [editor, updateBlockGutter],
  );

  const handleBlockDragStart = useCallback(() => {
    if (!editor || !isLegacyMode) return;

    const source =
      blockGutterTargetRef.current ??
      blockGutter?.target ??
      getTopLevelBlockActionRangeByIndex(editor, selectionMenu?.blockIndex) ??
      getCurrentBlockActionRange(editor);
    blockDragSessionRef.current = source ? createEditorBlockDragSession(editor.getJSON() as TiptapJson, source) : null;
    blockDropTargetRef.current = null;
    setBlockDropIndicator(null);
    setBlockDragPreview(null);
  }, [blockGutter?.target, editor, isLegacyMode, selectionMenu?.blockIndex]);

  const handleBlockDragEnd = useCallback(() => {
    clearBlockDragState();
  }, [clearBlockDragState]);

  const handleBlockDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (blockDragSessionRef.current === null) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleBlockPointerDragMove = useCallback(
    (point: SelectionBlockDragPoint) => {
      const session = blockDragSessionRef.current;
      const frame = editorFrameRef.current;
      if (!editor || !frame || !session) return;

      const frameRect = frame.getBoundingClientRect();
      const previewLeft = clamp(point.clientX - frameRect.left + 12, 8, Math.max(8, frame.clientWidth - 240));
      const previewTop = clamp(
        point.clientY - frameRect.top + frame.scrollTop + 12,
        frame.scrollTop + 8,
        Math.max(frame.scrollTop + 8, frame.scrollTop + frame.clientHeight - 72),
      );
      setBlockDragPreview({
        left: previewLeft,
        text: session.sourceText || blockControlMessages.draggingBlock,
        top: previewTop,
        type: session.sourceType,
      });

      const dropTarget = getBlockDropTarget(editor, frame, session.source, point);
      blockDropTargetRef.current = dropTarget;
      setBlockDropIndicator(dropTarget?.indicator ?? null);
    },
    [blockControlMessages.draggingBlock, editor],
  );

  const moveDraggedBlockAtPoint = useCallback(
    (point: SelectionBlockDragPoint) => {
      const session = blockDragSessionRef.current;
      const cachedDropTarget = blockDropTargetRef.current;
      clearBlockDragState();
      if (!editor || !editorFrameRef.current || !session || !isLegacyMode || !isWritable) return;

      const source = session.source;
      const dropTarget = cachedDropTarget ?? getBlockDropTarget(editor, editorFrameRef.current, source, point);
      if (!dropTarget) return;

      const sourceLocation = createDocumentBlockLocation(source);
      const targetIntent = createDocumentBlockMoveTarget(dropTarget);
      if (!sourceLocation || !targetIntent) return;
      const destination = applyScopedBlockMove(editor, {
        documentSignature: session.documentSignature,
        source: sourceLocation,
        target: targetIntent,
      });
      if (!destination) return;

      preserveEditorFrameScroll(editorFrameRef.current, () => {
        focusMovedBlock(editor, destination);
      });
    },
    [clearBlockDragState, editor, isLegacyMode, isWritable],
  );

  const handleBlockDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (blockDragSessionRef.current === null) return;

      event.preventDefault();
      event.stopPropagation();
      moveDraggedBlockAtPoint({ clientX: event.clientX, clientY: event.clientY });
    },
    [moveDraggedBlockAtPoint],
  );

  const characterCount = editor?.storage.characterCount.characters() ?? 0;
  const wordCount = editor?.storage.characterCount.words() ?? 0;
  const findResult = useMemo(
    () => findDocumentMatchesAtVersion(
      editor,
      findQuery,
      findOptions,
      documentVersion,
      contentJsonSignature,
    ),
    [contentJsonSignature, documentVersion, editor, findOptions, findQuery],
  );
  const normalizedFindIndex = findResult.matches.length > 0
    ? Math.min(activeFindIndex, findResult.matches.length - 1)
    : 0;
  const focusFindMatch = useCallback(
    (nextIndex: number) => {
      const match = findResult.matches[nextIndex];
      if (!editor || !match) return;

      setActiveFindIndex(nextIndex);
      editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).run();
      requestAnimationFrame(() => {
        const element = editor.view.nodeDOM(match.from) as HTMLElement | null;
        element?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
      });
    },
    [editor, findResult.matches],
  );
  const replaceCurrentFindMatch = useCallback(() => {
    const match = findResult.matches[normalizedFindIndex];
    if (!editor || !isWritable || !match) return;

    replaceDocumentMatch(editor, match, findReplaceText);
  }, [editor, findReplaceText, findResult.matches, isWritable, normalizedFindIndex]);
  const replaceAllFindMatches = useCallback(() => {
    if (!editor || !isWritable || findResult.matches.length === 0) return;

    replaceAllDocumentMatches(editor, findResult.matches, findReplaceText);
  }, [editor, findReplaceText, findResult.matches, isWritable]);
  const commandTargets = editor ? getEditorAiCommandTargets(editor) : [];
  const commandTarget = getEditorAiCommandTargetFromTargets(commandTargets, preferredCommandScope);
  const shouldShowSelectionMenu = canRunAiCommands
    && selectionMenu !== null
    && !isSelectionCommandLimitReached
    && !selectionAiResult;
  const shouldShowBlockGutter = blockGutter !== null && selectionMenu === null;
  const pluginHostContext: EditorHostContext | null = editor
    ? { editor, language, messages: editorMessages[language] }
    : null;
  const pluginBlockHostContext = pluginHostContext && blockGutter
    ? {
        ...pluginHostContext,
        block: {
          from: blockGutter.target.from,
          kind: blockGutter.target.kind,
          listItemPath: blockGutter.target.listItemPath,
          to: blockGutter.target.to,
          topLevelIndex: blockGutter.target.topLevelIndex,
        },
      }
    : undefined;
  const visibleRunningCommands =
    runningSelectionCommands.length > 0
      ? runningSelectionCommands
      : isSelectionCommandRunning && runningSelectionCommand
        ? [{ command: runningSelectionCommand, id: "active-selection-command" }]
        : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <EditorToolbar
        editor={isWritable ? editor : null}
        historyEnabled={isLegacyMode}
        messages={messages.toolbar}
        pluginContext={isWritable && isLegacyMode ? pluginHostContext : null}
        pluginItems={resolvedPluginContributions.toolbarItems}
        structuralTransformsEnabled={isLegacyMode}
      />
      {isFindOpen ? (
        <DocumentFindBar
          activeIndex={normalizedFindIndex}
          caseSensitive={findOptions.caseSensitive}
          error={findResult.error}
          matchCount={findResult.matches.length}
          messages={messages.find}
          onCaseSensitiveChange={(caseSensitive) => {
            setFindOptions((currentOptions) => ({ ...currentOptions, caseSensitive }));
            setActiveFindIndex(0);
          }}
          onClose={() => onFindOpenChange?.(false)}
          onNext={() =>
            focusFindMatch(nextDocumentFindIndex(normalizedFindIndex, findResult.matches.length, 1))
          }
          onPrevious={() =>
            focusFindMatch(nextDocumentFindIndex(normalizedFindIndex, findResult.matches.length, -1))
          }
          onQueryChange={(query) => {
            setFindQuery(query);
            setActiveFindIndex(0);
          }}
          onRegexChange={(regex) => {
            setFindOptions((currentOptions) => ({ ...currentOptions, regex }));
            setActiveFindIndex(0);
          }}
          onReplaceAll={replaceAllFindMatches}
          onReplaceCurrent={replaceCurrentFindMatch}
          onReplaceTextChange={setFindReplaceText}
          query={findQuery}
          readOnly={!isWritable}
          regex={findOptions.regex}
          replaceText={findReplaceText}
        />
      ) : null}
      <div className="px-4 pt-6 pb-2 sm:pt-8 sm:pr-8 sm:pl-16 lg:pl-20">
        <div className="mx-auto w-full max-w-[54rem]">
          <input
            aria-describedby={isCollaborationTitleInvalid ? collaborationTitleErrorId : undefined}
            aria-invalid={isCollaborationTitleInvalid || undefined}
            aria-label={messages.titleLabel}
            aria-required={!isLegacyMode || undefined}
            className="w-full bg-transparent text-2xl font-semibold leading-tight tracking-normal text-zinc-950 outline-none placeholder:text-zinc-400 sm:text-3xl"
            maxLength={isLegacyMode ? undefined : COLLABORATION_TITLE_MAX_LENGTH}
            onBlur={() => {
              if (collaborationFields && displayedTitle.trim().length === 0) {
                setCollaborationTitleDraft({
                  baseTitle: title,
                  fields: collaborationFields,
                  value: title,
                });
              }
            }}
            onChange={(event) => handleTitleChange(event.target.value)}
            readOnly={!isWritable}
            required={!isLegacyMode}
            value={displayedTitle}
          />
          {isCollaborationTitleInvalid ? (
            <p
              className="mt-2 text-sm font-medium text-rose-700"
              id={collaborationTitleErrorId}
              role="status"
            >
              {messages.titleRequired}
            </p>
          ) : null}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          className="relative h-full overflow-y-auto px-4 pt-2 pb-32 sm:pr-8 sm:pl-16 lg:pl-20"
          onDragOverCapture={handleBlockDragOver}
          onDropCapture={handleBlockDrop}
          onFocusCapture={handleEditorFocus}
          onMouseMove={handleEditorMouseMove}
          ref={handleEditorFrameRef}
        >
          <EditorContent
            className="mx-auto min-h-full w-full max-w-[54rem] [&_.tiptap]:min-h-[52rem] [&_.tiptap]:w-full [&_.tiptap]:break-words [&_.tiptap]:outline-none [&_.tiptap]:text-base [&_.tiptap]:leading-7 [&_.tiptap]:text-zinc-900 [&_.tiptap_.tableWrapper]:my-5 [&_.tiptap_.tableWrapper]:overflow-x-auto [&_.tiptap_a]:text-zinc-950 [&_.tiptap_a]:underline [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-zinc-300 [&_.tiptap_blockquote]:pl-4 [&_.tiptap_h1]:text-3xl [&_.tiptap_h1]:font-semibold [&_.tiptap_h2]:text-2xl [&_.tiptap_h2]:font-semibold [&_.tiptap_h3]:text-xl [&_.tiptap_h3]:font-semibold [&_.tiptap_li]:my-1 [&_.tiptap_ol]:my-3 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-6 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:text-zinc-400 [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p]:my-3 [&_.tiptap_table]:my-5 [&_.tiptap_table]:w-full [&_.tiptap_table]:border-collapse [&_.tiptap_table]:text-sm [&_.tiptap_td]:border [&_.tiptap_td]:border-zinc-200 [&_.tiptap_td]:px-3 [&_.tiptap_td]:py-2 [&_.tiptap_td]:align-top [&_.tiptap_th]:border [&_.tiptap_th]:border-zinc-300 [&_.tiptap_th]:bg-zinc-100 [&_.tiptap_th]:px-3 [&_.tiptap_th]:py-2 [&_.tiptap_th]:text-left [&_.tiptap_th]:font-semibold [&_.tiptap_ul]:my-3 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-6"
            editor={editor}
          />
          <BlockGutterControls
            isListItem={blockGutter?.target.kind === "listItem"}
            isVisible={shouldShowBlockGutter && isWritable}
            language={language}
            left={blockGutter?.left ?? 0}
            onAddBlock={handleAddBlockBelow}
            onBlockAction={handleBlockAction}
            onBlockDragEnd={handleBlockDragEnd}
            onBlockDragStart={handleBlockDragStart}
            onBlockPointerDragEnd={moveDraggedBlockAtPoint}
            onBlockPointerDragMove={handleBlockPointerDragMove}
            pluginActions={resolvedPluginContributions.blockActions}
            pluginContext={pluginBlockHostContext}
            structuralTransformsEnabled={isLegacyMode}
            top={blockGutter?.top ?? 0}
          />
          <BlockDropIndicator indicator={blockDropIndicator} />
          {blockDragPreview ? (
            <div
              aria-label={blockControlMessages.dragPreviewLabel}
              className="pointer-events-none absolute z-40 max-w-56 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-xs text-zinc-600 shadow-lg shadow-zinc-950/10"
              role="status"
              style={{ left: blockDragPreview.left, top: blockDragPreview.top }}
            >
              <span className="font-medium text-zinc-900">
                {blockDragPreview.type === "listItem"
                  ? blockControlMessages.listItem
                  : blockControlMessages.block}
              </span>
              {blockDragPreview.text ? <span className="ml-1">{blockDragPreview.text}</span> : null}
            </div>
          ) : null}
          <SelectionAiMenu
            commands={resolvedPluginContributions.selectionCommands}
            hasSelection={shouldShowSelectionMenu}
            language={language}
            left={selectionMenu?.left}
            onCommand={handleCommand}
            side={selectionMenu?.side}
            top={selectionMenu?.top}
          />
          <SlashCommandMenu
            editor={isWritable && isLegacyMode ? editor : null}
            frameRef={editorFrameRef}
            language={language}
            onAiCommand={isWritable && isLegacyMode && canRunAiCommands ? handleFreeformCommand : undefined}
            slashCommands={isLegacyMode ? resolvedPluginContributions.slashCommands : []}
          />
          {visibleRunningCommands.map((runningCommand, index) => (
            <SelectionAiRunningStatus
              anchor={offsetRunningAnchor(runningCommand.anchor, index)}
              command={runningCommand.command}
              isVisible={Boolean(runningCommand.anchor)}
              key={runningCommand.id}
              language={language}
              selectionCommands={resolvedPluginContributions.selectionCommands}
            />
          ))}
          <SelectionAiResultPopover
            frame={editorFrameElement}
            language={language}
            onApply={(proposalId, applyMode) => onApplySelectionAiResult?.(proposalId, applyMode)}
            onDismiss={() => onDismissSelectionAiResult?.()}
            onRetry={onRetrySelectionAiResult}
            result={selectionAiResult}
          />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 px-3 sm:px-4">
          <DocumentAiCommandBar
            availableScopes={commandTargets.map((target) => target.scope)}
            disabled={!canRunAiCommands || !commandTarget}
            isAtCapacity={isSelectionCommandLimitReached}
            isRunning={isSelectionCommandRunning}
            language={language}
            messages={editorMessages[language].aiCommandBar}
            onScopeChange={setPreferredCommandScope}
            onSubmit={handleFreeformCommand}
            referenceCandidates={referenceCandidates}
            runningCount={runningSelectionCommands.length}
            runningLimit={runningSelectionCommandLimit}
            scope={commandTarget?.scope ?? "document"}
          />
        </div>
      </div>
      <footer className="flex items-center justify-end gap-4 border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 sm:px-6">
        <span>
          {wordCount} {messages.words}
        </span>
        <span>
          {characterCount} {messages.characters}
        </span>
      </footer>
    </div>
  );
}

function findDocumentMatchesAtVersion(
  editor: RuntimeEditor | null,
  query: string,
  options: DocumentFindOptions,
  documentVersion: number,
  contentJsonSignature: string,
) {
  // These values intentionally invalidate the memo for editor transactions
  // and legacy prop synchronization, while the current document is read from
  // the editor instance below.
  void documentVersion;
  void contentJsonSignature;
  return editor && query
    ? findDocumentMatches(editor.state.doc, query, options)
    : { error: null, matches: [] };
}

function EditorToolbar({
  editor,
  historyEnabled,
  messages,
  pluginContext,
  pluginItems,
  structuralTransformsEnabled,
}: {
  editor: RuntimeEditor | null;
  historyEnabled: boolean;
  messages: EditorMessages["editor"]["toolbar"];
  pluginContext: EditorHostContext | null;
  pluginItems: EditorPluginContributions["toolbarItems"];
  structuralTransformsEnabled: boolean;
}) {
  const blockStyle = editor ? getActiveBlockStyle(editor) : "paragraph";

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-zinc-200 bg-white px-2 sm:px-4">
      <div aria-label={messages.toolbarLabel} className="flex min-w-max items-center gap-1" role="toolbar">
        <ToolbarButton
          disabled={!editor || !historyEnabled}
          icon={Undo2}
          label={messages.undo}
          onClick={() => executeEditorCommand(editor, "undo")}
        />
        <ToolbarButton
          disabled={!editor || !historyEnabled}
          icon={Redo2}
          label={messages.redo}
          onClick={() => executeEditorCommand(editor, "redo")}
        />
        <span className="mx-1 h-5 w-px bg-zinc-200" />
        <label className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100">
          <Type aria-hidden="true" className="size-4" />
          <span className="sr-only">{messages.style}</span>
          <select
            aria-label={messages.style}
            className="w-28 bg-transparent text-sm font-medium outline-none disabled:cursor-not-allowed"
            disabled={!editor || !structuralTransformsEnabled}
            onChange={(event) => applyBlockStyle(editor, event.currentTarget.value)}
            value={blockStyle}
          >
            <option value="paragraph">{messages.paragraph}</option>
            <option value="heading1">{messages.heading1}</option>
            <option value="heading2">{messages.heading2}</option>
            <option value="heading3">{messages.heading3}</option>
          </select>
        </label>
        <span className="mx-1 h-5 w-px bg-zinc-200" />
        <ToolbarButton
          active={editor?.isActive("bold")}
          disabled={!editor}
          icon={Bold}
          label={messages.bold}
          onClick={() => executeEditorCommand(editor, "toggleBold")}
        />
        <ToolbarButton
          active={editor?.isActive("italic")}
          disabled={!editor}
          icon={Italic}
          label={messages.italic}
          onClick={() => executeEditorCommand(editor, "toggleItalic")}
        />
        <ToolbarButton
          active={editor?.isActive("strike")}
          disabled={!editor}
          icon={Strikethrough}
          label={messages.strike}
          onClick={() => executeEditorCommand(editor, "toggleStrike")}
        />
        <ToolbarButton
          active={editor?.isActive("code")}
          disabled={!editor}
          icon={Code2}
          label={messages.code}
          onClick={() => executeEditorCommand(editor, "toggleCode")}
        />
        <span className="mx-1 h-5 w-px bg-zinc-200" />
        <ToolbarButton
          active={editor?.isActive("bulletList")}
          disabled={!editor || !structuralTransformsEnabled}
          icon={List}
          label={messages.bulletList}
          onClick={() => executeEditorCommand(editor, "toggleBulletList")}
        />
        <ToolbarButton
          active={editor?.isActive("orderedList")}
          disabled={!editor || !structuralTransformsEnabled}
          icon={ListOrdered}
          label={messages.orderedList}
          onClick={() => executeEditorCommand(editor, "toggleOrderedList")}
        />
        <ToolbarButton
          active={editor?.isActive("blockquote")}
          disabled={!editor || !structuralTransformsEnabled}
          icon={Quote}
          label={messages.blockquote}
          onClick={() => executeEditorCommand(editor, "toggleBlockquote")}
        />
        {pluginItems.length > 0 ? <span className="mx-1 h-5 w-px bg-zinc-200" /> : null}
        {pluginItems.map((item) => {
          const isEnabled = pluginContext
            ? invokeEditorPluginContribution(
                "toolbarItem",
                item.id,
                () => item.isEnabled?.(pluginContext) ?? true,
                false,
              )
            : false;

          return (
            <button
              aria-label={item.label}
              className="inline-flex h-8 items-center justify-center rounded px-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-300"
              disabled={!isEnabled}
              key={item.id}
              onClick={() => {
                if (!pluginContext) return;
                invokeEditorPluginContribution("toolbarItem", item.id, () => item.run(pluginContext), undefined);
              }}
              title={item.label}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToolbarButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: typeof Bold;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={[
        "inline-flex size-8 items-center justify-center rounded text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-300",
        active ? "bg-zinc-100 text-zinc-950" : "",
      ].join(" ")}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

function BlockDropIndicator({ indicator }: { indicator: BlockDropIndicator | null }) {
  if (!indicator) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-40 h-0.5 rounded-full bg-sky-500/80"
      data-block-drop-indicator="true"
      style={{ left: indicator.left, top: indicator.top, width: indicator.width }}
    >
      <span className="absolute left-0 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500/80" />
    </div>
  );
}

function getActiveBlockStyle(editor: RuntimeEditor) {
  if (editor.isActive("heading", { level: 1 })) return "heading1";
  if (editor.isActive("heading", { level: 2 })) return "heading2";
  if (editor.isActive("heading", { level: 3 })) return "heading3";
  return "paragraph";
}

function applyBlockStyle(editor: RuntimeEditor | null, value: string) {
  if (!editor) return;

  if (value === "heading1") {
    executeEditorCommand(editor, "toggleHeading", { level: 1 });
    return;
  }

  if (value === "heading2") {
    executeEditorCommand(editor, "toggleHeading", { level: 2 });
    return;
  }

  if (value === "heading3") {
    executeEditorCommand(editor, "toggleHeading", { level: 3 });
    return;
  }

  executeEditorCommand(editor, "setParagraph");
}

function insertBlockBelow(editor: RuntimeEditor | null, target?: BlockActionRange | null) {
  if (!editor) return;

  const range = target ?? getCurrentBlockActionRange(editor);
  if (range?.kind === "listItem") {
    insertListItemBelow(editor, range);
    return;
  }

  const insertAt = range?.to ?? editor.state.selection.to;
  executeEditorCommand(editor, "insertContentAt", insertAt, { type: "paragraph" });
  executeEditorCommand(editor, "focus", insertAt + 1);
}

function duplicateBlock(editor: RuntimeEditor, target?: BlockActionRange | null) {
  const range = target ?? getCurrentBlockActionRange(editor);
  if (!range) return;

  executeEditorCommand(editor, "insertContentAt", range.to, range.node.toJSON());
  executeEditorCommand(editor, "focus", range.kind === "listItem" ? range.to + 2 : range.to + 1);
}

function deleteBlock(
  editor: RuntimeEditor,
  target?: BlockActionRange | null,
  collaborationDocument?: CollaborationEditorBinding["document"] | null,
) {
  const range = target ?? getCurrentBlockActionRange(editor);
  if (!range) return;

  if (range.kind === "topLevel" && editor.state.doc.childCount <= 1) {
    applyScopedLastBlockDeletion(editor, range, collaborationDocument);
    executeEditorCommand(editor, "focus", "end");
    return;
  }

  executeEditorCommand(editor, "deleteRange", { from: range.from, to: range.to });
  executeEditorCommand(editor, "focus", Math.max(1, range.from));
}

function moveBlock(editor: RuntimeEditor, target: BlockActionRange | null | undefined, direction: "down" | "up") {
  const range = target ?? getCurrentBlockActionRange(editor);
  if (!range) return;

  const source = createDocumentBlockLocation(range);
  if (!source) return;
  const destination = applyScopedBlockMove(editor, {
    source,
    target: { direction, kind: "relative" },
  });

  if (destination) focusMovedBlock(editor, destination);
}

function changeListItemLevel(
  editor: RuntimeEditor,
  target: BlockActionRange | null | undefined,
  direction: "indent" | "outdent",
) {
  const range = target ?? getCurrentBlockActionRange(editor);
  if (range?.kind !== "listItem") return;

  if (direction === "outdent" && outdentListItem(editor, range)) {
    return;
  }

  const selectionPosition = clamp(range.from + 2, 1, Math.max(1, Math.min(range.to - 1, editor.state.doc.content.size)));
  const commands = editor.commands as unknown as Record<string, (...commandArgs: unknown[]) => boolean>;
  editor.view.focus();
  commands.setTextSelection?.(selectionPosition);
  commands[direction === "indent" ? "sinkListItem" : "liftListItem"]?.(range.node.type.name);
}

function convertListItemToText(editor: RuntimeEditor, target: BlockActionRange | null | undefined) {
  const range = target ?? getCurrentBlockActionRange(editor);
  if (range?.kind !== "listItem") return;

  const destination = applyScopedListItemConversion(editor, range);
  if (destination) focusMovedBlock(editor, destination);
}

function outdentListItem(editor: RuntimeEditor, range: BlockActionRange) {
  const destination = applyScopedOutdent(editor, range);
  if (!destination) return false;
  focusMovedBlock(editor, destination);
  return true;
}

function insertListItemBelow(editor: RuntimeEditor, range: BlockActionRange) {
  editor
    .chain()
    .focus()
    .insertContentAt(range.to, {
      attrs: range.node.type.name === "taskItem" ? { checked: false } : undefined,
      content: [{ type: "paragraph" }],
      type: range.node.type.name,
    })
    .setTextSelection(range.to + 2)
    .run();
}

function getCurrentBlockActionRange(editor: RuntimeEditor) {
  return getBlockActionRangeAtPosition(editor, editor.state.selection.from);
}

function hasActiveEditorTextSelection(editorDom: HTMLElement) {
  const selection = editorDom.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(
    anchorNode &&
      focusNode &&
      editorDom.contains(anchorNode) &&
      editorDom.contains(focusNode),
  );
}

function focusMovedBlock(editor: RuntimeEditor, target: DocumentBlockDestination) {
  const range =
    target.kind === "listItem"
      ? getListItemBlockActionRangeByPath(editor, target.path[0] ?? -1, target.path.slice(1))
      : getTopLevelBlockActionRangeByIndex(editor, target.path[0]);
  if (!range) {
    editor.view.focus();
    return;
  }

  focusBlockRange(editor, range);
}

function focusBlockRange(editor: RuntimeEditor, range: BlockActionRange) {
  const position = findTextSelectionPositionInRange(editor, range.from, range.to);
  if (position === null) {
    editor.view.focus();
    return;
  }

  const commands = editor.commands as unknown as Record<string, (...commandArgs: unknown[]) => boolean>;
  editor.view.focus();
  commands.setTextSelection?.(position);
}

function preserveEditorFrameScroll(frame: HTMLDivElement, action: () => void) {
  const scrollTop = frame.scrollTop;
  action();
  restoreEditorFrameScroll(frame, scrollTop);

  requestAnimationFrame(() => {
    restoreEditorFrameScroll(frame, scrollTop);
  });
}

function restoreEditorFrameScroll(frame: HTMLDivElement, scrollTop: number) {
  try {
    frame.scrollTop = scrollTop;
  } catch {
    // Some test DOM descriptors expose scrollTop as readonly; browsers keep it writable.
  }
}

function findTextSelectionPositionInRange(editor: RuntimeEditor, from: number, to: number) {
  let textSelectionPosition: number | null = null;

  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (textSelectionPosition !== null) {
      return false;
    }

    if (node.isTextblock) {
      textSelectionPosition = Math.min(position + 1, editor.state.doc.content.size);
      return false;
    }

    return true;
  });

  return textSelectionPosition;
}

function executeEditorCommand(editor: RuntimeEditor | null, commandName: string, ...args: unknown[]) {
  if (!editor) return;

  editor.view.focus();
  const commands = editor.commands as unknown as Record<string, (...commandArgs: unknown[]) => boolean>;
  commands[commandName]?.(...args);
}

function SelectionAiRunningStatus({
  anchor,
  command,
  isVisible,
  language,
  selectionCommands,
}: {
  anchor?: SelectionAiAnchor;
  command: string;
  isVisible: boolean;
  language: EditorLanguage;
  selectionCommands: EditorSelectionCommand[];
}) {
  if (!isVisible || !anchor) return null;

  const messages = editorMessages[language].selectionMenu;
  const commandLabel = getSelectionRunningCommandLabel(command, selectionCommands);

  return (
    <div
      aria-label={messages.runningStatusLabel}
      className="pointer-events-none absolute z-30 w-[min(20rem,calc(100%-2rem))]"
      data-side={anchor.side}
      role="status"
      style={{ left: anchor.left, top: anchor.top }}
    >
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-white/95 px-3 py-2 shadow-lg shadow-zinc-950/10 backdrop-blur">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-zinc-500" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-zinc-800">
            {formatEditorMessage(messages.running, { command: commandLabel })}
          </span>
          <span className="block truncate text-[11px] leading-4 text-zinc-500">{messages.runningPinned}</span>
        </span>
      </div>
    </div>
  );
}

function getSelectionRunningCommandLabel(command: string, selectionCommands: EditorSelectionCommand[]) {
  return selectionCommands.find((item) => item.command === command)?.ariaLabel ?? (command || "AI");
}

function offsetRunningAnchor(anchor: SelectionAiAnchor | undefined, index: number): SelectionAiAnchor | undefined {
  if (!anchor) return undefined;

  return {
    ...anchor,
    top: anchor.top + index * 48,
  };
}

function readSelectionMenuPosition(
  currentEditor: NonNullable<ReturnType<typeof useEditor>>,
  frame: HTMLDivElement | null,
  selectedText: string,
): SelectionMenuState {
  if (!frame) {
    return getFallbackSelectionMenuPosition(selectedText);
  }

  try {
    const { from, to } = currentEditor.state.selection;
    const selectionRects = readBrowserSelectionRects(currentEditor.view.dom);
    return getSelectionMenuPosition({
      frameRect: frame.getBoundingClientRect(),
      scrollTop: frame.scrollTop,
      selectedText,
      selectionEnd: selectionRects?.end ?? currentEditor.view.coordsAtPos(to),
      selectionStart: selectionRects?.start ?? currentEditor.view.coordsAtPos(from),
    });
  } catch {
    return getFallbackSelectionMenuPosition(selectedText);
  }
}

function readBrowserSelectionRects(editorDom: HTMLElement): { end: SelectionRect; start: SelectionRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const anchor =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!anchor || !editorDom.contains(anchor)) return null;

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;
  const firstRect = rects[0]!;
  const lastRect = rects[rects.length - 1]!;

  return {
    end: toSelectionRect(lastRect),
    start: toSelectionRect(firstRect),
  };
}

export function getSelectionMenuPosition({
  frameRect,
  scrollTop,
  selectedText,
  selectionEnd,
  selectionStart,
}: SelectionMenuPositionInput): SelectionMenuState {
  const menuWidth = Math.min(360, Math.max(240, frameRect.width - 32));
  const selectionLeft = Math.min(selectionStart.left, selectionEnd.left);
  const selectionRight = Math.max(selectionStart.right, selectionEnd.right);
  const selectionCenter = (selectionLeft + selectionRight) / 2 - frameRect.left;
  const left = clamp(selectionCenter - menuWidth / 2, 16, Math.max(16, frameRect.width - menuWidth - 16));
  const selectionTop = Math.min(selectionStart.top, selectionEnd.top) - frameRect.top + scrollTop;
  const selectionBottom = Math.max(selectionStart.bottom, selectionEnd.bottom) - frameRect.top + scrollTop;
  const firstVisibleLineBottom = Math.min(selectionStart.bottom, selectionEnd.bottom) - frameRect.top + scrollTop;
  const topCandidate = selectionTop - SELECTION_MENU_HEIGHT - SELECTION_MENU_GAP;

  if (topCandidate < SELECTION_MENU_GAP) {
    const viewportBottom = scrollTop + frameRect.height - SELECTION_MENU_GAP;
    return {
      left,
      selectedText,
      side: "bottom",
      top: clamp(
        selectionBottom + SELECTION_MENU_GAP,
        firstVisibleLineBottom + SELECTION_MENU_GAP,
        Math.max(SELECTION_MENU_GAP, viewportBottom - SELECTION_MENU_HEIGHT),
      ),
    };
  }

  return {
    left,
    selectedText,
    side: "top",
    top: topCandidate,
  };
}

function toSelectionRect(rect: SelectionRect): SelectionRect {
  return {
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    top: rect.top,
  };
}

function getFallbackSelectionMenuPosition(selectedText: string): SelectionMenuState {
  return { left: 16, selectedText, side: "top", top: 16 };
}

function readCommandBarResultAnchor(frame: HTMLDivElement | null): SelectionAiAnchor {
  if (!frame) {
    return { left: 16, side: "top", top: 16 };
  }

  const popoverWidth = Math.min(448, Math.max(280, frame.clientWidth - 32));
  return {
    left: clamp(frame.clientWidth / 2 - popoverWidth / 2, 16, Math.max(16, frame.clientWidth - popoverWidth - 16)),
    side: "top",
    top: Math.max(16, frame.scrollTop + frame.clientHeight - 320),
  };
}

function escapeCssAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
