"use client";

import { Loader2, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import type { AiCommandScope } from "./editor-command-targets";

type DocumentAiCommandBarProps = {
  availableScopes?: AiCommandScope[];
  disabled?: boolean;
  isAtCapacity?: boolean;
  isRunning?: boolean;
  language?: EditorLanguage;
  messages?: EditorMessages["aiCommandBar"];
  runningCount?: number;
  runningLimit?: number;
  onScopeChange?: (scope: AiCommandScope) => void;
  onSubmit: (command: string) => void;
  scope: AiCommandScope;
};

export function DocumentAiCommandBar({
  availableScopes = ["document"],
  disabled = false,
  isAtCapacity = false,
  isRunning = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiCommandBar,
  runningCount = 0,
  runningLimit = 5,
  onScopeChange,
  onSubmit,
  scope,
}: DocumentAiCommandBarProps) {
  const [command, setCommand] = useState("");
  const isDisabled = disabled || isAtCapacity;
  const trimmedCommand = command.trim();
  const placeholder = isAtCapacity
    ? formatEditorMessage(messages.capacityReached, {
        count: String(runningCount),
        limit: String(runningLimit),
      })
    : disabled
      ? messages.noTarget
      : messages.placeholder;

  return (
    <form
      aria-label={messages.inputLabel}
      className="pointer-events-auto mx-auto flex w-[min(36rem,calc(100%-2rem))] items-center gap-2 rounded-full border border-zinc-200 bg-white px-2 py-2 shadow-xl shadow-zinc-950/15"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedCommand || isDisabled) return;

        onSubmit(trimmedCommand);
        setCommand("");
      }}
    >
      <label className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 text-xs font-medium text-zinc-600">
        <Sparkles aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{messages.scopeInputLabel}</span>
        <select
          aria-label={messages.scopeInputLabel}
          className="max-w-28 bg-transparent text-xs font-medium text-zinc-600 outline-none disabled:cursor-not-allowed"
          disabled={isDisabled}
          onChange={(event) => onScopeChange?.(event.currentTarget.value as AiCommandScope)}
          value={scope}
        >
          {availableScopes.map((availableScope) => (
            <option key={availableScope} value={availableScope}>
              {messages.scopeLabels[availableScope]}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label={messages.inputLabel}
        className="min-w-0 flex-1 bg-transparent px-1 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
        disabled={isDisabled}
        onChange={(event) => setCommand(event.currentTarget.value)}
        placeholder={placeholder}
        value={command}
      />
      <button
        aria-label={messages.submit}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        disabled={isDisabled || !trimmedCommand}
        title={messages.submit}
        type="submit"
      >
        {isRunning && isAtCapacity ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Send aria-hidden="true" className={language === "ko" ? "size-4" : "size-4"} />
        )}
      </button>
    </form>
  );
}
