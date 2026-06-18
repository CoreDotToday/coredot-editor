"use client";

import {
  BarChart3,
  Languages,
  Loader2,
  Minimize2,
  PenLine,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { CSSProperties } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import { createDefaultSelectionCommands } from "@/plugins/builtin/ai-writing-plugin";
import type {
  EditorSelectionCommand,
  EditorSelectionCommandIcon,
  EditorSelectionCommandMetadata,
} from "@/plugins/types";

type SelectionAiMenuSide = "top" | "bottom";

type SelectionAiMenuProps = {
  commands?: EditorSelectionCommand[];
  hasSelection: boolean;
  isRunning?: boolean;
  language?: EditorLanguage;
  left?: number;
  onCommand: (command: string, metadata: EditorSelectionCommandMetadata) => void;
  runningCommand?: string;
  side?: SelectionAiMenuSide;
  selectedText?: string;
  top?: number;
};

const commandIconMap: Record<EditorSelectionCommandIcon, typeof Wand2> = {
  "bar-chart": BarChart3,
  languages: Languages,
  minimize: Minimize2,
  "pen-line": PenLine,
  sparkles: Sparkles,
  wand: Wand2,
};

export function SelectionAiMenu({
  commands: contributedCommands,
  hasSelection,
  isRunning = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  left = 16,
  onCommand,
  runningCommand = "",
  side = "top",
  top = 16,
}: SelectionAiMenuProps) {
  if (!hasSelection) return null;

  const messages = editorMessages[language].selectionMenu;
  const commands = contributedCommands ?? createDefaultSelectionCommands(editorMessages[language]);
  const style: CSSProperties = {
    left,
    top,
  };

  return (
    <div
      aria-label={messages.toolbarLabel}
      className="absolute z-40 flex max-w-[calc(100%-2rem)] justify-center"
      data-side={side}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      style={style}
    >
      <div className="flex w-[min(22rem,calc(100vw-2rem))] flex-wrap items-center gap-1 rounded-md border border-zinc-200 bg-white/95 p-1 shadow-xl shadow-zinc-950/15 backdrop-blur">
        {isRunning ? (
          <div
            aria-live="polite"
            className="inline-flex min-h-8 max-w-full items-center justify-center gap-2 rounded px-2.5 text-xs font-medium text-zinc-700"
            role="status"
          >
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-zinc-500" />
            <span className="truncate">
              {formatEditorMessage(messages.running, { command: getCommandLabel(runningCommand, commands) })}
            </span>
          </div>
        ) : null}
        {!isRunning
          ? commands.map(({ ariaLabel, command, defaultApplyMode = "replace", icon, id, label }) => {
              const Icon = commandIconMap[icon];

              return (
                <button
                  aria-label={ariaLabel}
                  className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded px-2 text-left text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950"
                  key={id}
                  onClick={() => onCommand(command, { defaultApplyMode, id })}
                  title={ariaLabel}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-zinc-500" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })
          : null}
      </div>
    </div>
  );
}

function getCommandLabel(command: string, commands: EditorSelectionCommand[]) {
  const commandConfig = commands.find((item) => item.command === command);
  return commandConfig ? commandConfig.ariaLabel : command || "AI";
}
