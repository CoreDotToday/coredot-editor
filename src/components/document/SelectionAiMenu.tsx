"use client";

import { BarChart3, Languages, Loader2, Minimize2, Sparkles, Wand2 } from "lucide-react";
import type { CSSProperties } from "react";
import { editorMessages, formatEditorMessage, type EditorLanguage } from "@/features/i18n/editor-language";

type SelectionAiMenuSide = "top" | "bottom";

type SelectionAiMenuProps = {
  hasSelection: boolean;
  isRunning?: boolean;
  language?: EditorLanguage;
  left?: number;
  onCommand: (command: string) => void;
  runningCommand?: string;
  side?: SelectionAiMenuSide;
  selectedText?: string;
  top?: number;
};

const commands = [
  { command: "Improve clarity", icon: Wand2, messageKey: "improveClarity" },
  { command: "Make concise", icon: Minimize2, messageKey: "makeConcise" },
  { command: "Make more strategic", icon: Sparkles, messageKey: "makeStrategic" },
  { command: "Strengthen evidence", icon: BarChart3, messageKey: "strengthenEvidence" },
  { command: "Translate to Korean", icon: Languages, messageKey: "translateKorean" },
  { command: "Translate to English", icon: Languages, messageKey: "translateEnglish" },
] as const;

export function SelectionAiMenu({
  hasSelection,
  isRunning = false,
  language = "en",
  left = 16,
  onCommand,
  runningCommand = "",
  side = "top",
  top = 16,
}: SelectionAiMenuProps) {
  if (!hasSelection) return null;

  const messages = editorMessages[language].selectionMenu;
  const style: CSSProperties = {
    left,
    top,
  };

  return (
    <div
      aria-label={messages.toolbarLabel}
      className="absolute z-20 flex max-w-[calc(100%-2rem)] justify-center"
      data-side={side}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      style={style}
    >
      <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 rounded-md border border-zinc-200 bg-white/95 p-1 shadow-lg shadow-zinc-950/10 backdrop-blur">
        {isRunning ? (
          <div
            aria-live="polite"
            className="inline-flex h-8 max-w-full items-center justify-center gap-2 rounded px-2.5 text-xs font-medium text-zinc-700"
            role="status"
          >
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-zinc-500" />
            <span className="truncate">
              {formatEditorMessage(messages.running, { command: getCommandLabel(runningCommand, messages) })}
            </span>
          </div>
        ) : null}
        {!isRunning
          ? commands.map(({ command, icon: Icon, messageKey }) => {
              const commandMessage = messages.commands[messageKey];

              return (
                <button
                  aria-label={commandMessage.ariaLabel}
                  className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-950"
                  key={command}
                  onClick={() => onCommand(command)}
                  title={commandMessage.ariaLabel}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  <span className="truncate">{commandMessage.label}</span>
                </button>
              );
            })
          : null}
      </div>
    </div>
  );
}

type SelectionMenuMessages = (typeof editorMessages)[EditorLanguage]["selectionMenu"];

function getCommandLabel(command: string, messages: SelectionMenuMessages) {
  const commandConfig = commands.find((item) => item.command === command);
  return commandConfig ? messages.commands[commandConfig.messageKey].ariaLabel : command || "AI";
}
