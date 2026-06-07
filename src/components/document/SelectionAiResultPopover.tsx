"use client";

import { X } from "lucide-react";
import type { CSSProperties } from "react";
import type { AiProposalApplyMode } from "@/components/ai/AiReviewPanel";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  getSelectionCommandLabel,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import type { SelectionAiAnchor } from "./DocumentEditor";

export type SelectionAiResultPreview = {
  anchor?: SelectionAiAnchor;
  command: string;
  defaultApplyMode: AiProposalApplyMode;
  explanation: string;
  proposalId: string;
  replacementText: string;
  targetText: string;
};

type SelectionAiResultPopoverProps = {
  frame?: HTMLDivElement | null;
  language?: EditorLanguage;
  onApply: (proposalId: string, applyMode: AiProposalApplyMode) => void;
  onDismiss: () => void;
  onRetry?: () => void;
  result: SelectionAiResultPreview | null;
};

const POPOVER_MARGIN = 16;
const POPOVER_MAX_HEIGHT = 448;
const POPOVER_MAX_WIDTH = 448;
const POPOVER_MIN_HEIGHT = 160;
const POPOVER_MIN_WIDTH = 280;

export function SelectionAiResultPopover({
  frame,
  language = DEFAULT_EDITOR_LANGUAGE,
  onApply,
  onDismiss,
  onRetry,
  result,
}: SelectionAiResultPopoverProps) {
  if (!result) return null;

  const messages = editorMessages[language].selectionResult;
  const alternateApplyMode = result.defaultApplyMode === "insert_below" ? "replace" : "insert_below";
  const commandLabel = getSelectionCommandLabel(result.command, language);
  const style = getPopoverStyle(result.anchor, frame);

  return (
    <div
      aria-label={messages.regionLabel}
      aria-live="polite"
      aria-atomic="true"
      className="absolute z-30"
      data-side={result.anchor?.side ?? "bottom"}
      onMouseDown={(event) => event.preventDefault()}
      role="region"
      style={style}
    >
      <div className="flex max-h-full flex-col rounded-md border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-950/15">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-normal text-zinc-500">{messages.title}</p>
            <p className="mt-1 truncate text-sm font-medium text-zinc-950">{commandLabel}</p>
          </div>
          <button
            aria-label={messages.dismiss}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-950"
            onClick={onDismiss}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="mt-3 min-h-0 space-y-2 overflow-y-auto pr-1 text-sm leading-6">
          <p className="line-clamp-2 text-zinc-500">{result.explanation}</p>
          <div className="rounded border border-zinc-200 bg-white px-2.5 py-2">
            <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">{messages.original}</p>
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-zinc-700">{result.targetText}</p>
          </div>
          <div className="rounded border border-zinc-200 bg-zinc-50 px-2.5 py-2">
            <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">{messages.suggestion}</p>
            <p className="mt-1 whitespace-pre-wrap text-zinc-800">{result.replacementText}</p>
          </div>
        </div>

        <div className="mt-3 flex shrink-0 flex-wrap justify-end gap-2">
          {onRetry ? (
            <button
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              onClick={onRetry}
              type="button"
            >
              {messages.tryAgain}
            </button>
          ) : null}
          <button
            className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            onClick={() => onApply(result.proposalId, alternateApplyMode)}
            type="button"
          >
            {getApplyLabel(alternateApplyMode, messages)}
          </button>
          <button
            className="rounded-md bg-zinc-950 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
            onClick={() => onApply(result.proposalId, result.defaultApplyMode)}
            type="button"
          >
            {getApplyLabel(result.defaultApplyMode, messages)}
          </button>
        </div>
      </div>
    </div>
  );
}

type SelectionResultMessages = (typeof editorMessages)[EditorLanguage]["selectionResult"];

function getPopoverStyle(anchor: SelectionAiAnchor | undefined, frame: HTMLDivElement | null | undefined): CSSProperties {
  if (!frame) {
    return {
      left: anchor?.left ?? POPOVER_MARGIN,
      maxHeight: POPOVER_MAX_HEIGHT,
      top: anchor?.top ?? POPOVER_MARGIN,
      width: `min(${POPOVER_MAX_WIDTH}px, calc(100% - ${POPOVER_MARGIN * 2}px))`,
    };
  }

  const width = Math.min(POPOVER_MAX_WIDTH, Math.max(POPOVER_MIN_WIDTH, frame.clientWidth - POPOVER_MARGIN * 2));
  const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, frame.clientHeight - POPOVER_MARGIN * 2));
  const minTop = frame.scrollTop + POPOVER_MARGIN;
  const maxTop = Math.max(minTop, frame.scrollTop + frame.clientHeight - maxHeight - POPOVER_MARGIN);
  const maxLeft = Math.max(POPOVER_MARGIN, frame.clientWidth - width - POPOVER_MARGIN);

  return {
    left: clamp(anchor?.left ?? POPOVER_MARGIN, POPOVER_MARGIN, maxLeft),
    maxHeight,
    top: clamp(anchor?.top ?? minTop, minTop, maxTop),
    width,
  };
}

function getApplyLabel(applyMode: AiProposalApplyMode, messages: SelectionResultMessages) {
  return applyMode === "insert_below" ? messages.insertBelow : messages.replace;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
