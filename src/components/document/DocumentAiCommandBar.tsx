"use client";

import { Loader2, Send, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  formatEditorMessage,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";
import {
  getActiveDocumentMentionQuery,
  resolveAiDocumentReferences,
  type AiDocumentReferenceCandidate,
  type ResolvedAiDocumentReference,
} from "@/features/ai/ai-reference-parser";
import type { AiCommandScope } from "./editor-command-targets";

type DocumentAiCommandBarProps = {
  availableScopes?: AiCommandScope[];
  disabled?: boolean;
  isAtCapacity?: boolean;
  isRunning?: boolean;
  language?: EditorLanguage;
  messages?: EditorMessages["aiCommandBar"];
  referenceCandidates?: AiDocumentReferenceCandidate[];
  runningCount?: number;
  runningLimit?: number;
  onScopeChange?: (scope: AiCommandScope) => void;
  onSubmit: (command: string, references?: ResolvedAiDocumentReference[]) => void;
  scope: AiCommandScope;
};

export function DocumentAiCommandBar({
  availableScopes = ["document"],
  disabled = false,
  isAtCapacity = false,
  isRunning = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].aiCommandBar,
  referenceCandidates = [],
  runningCount = 0,
  runningLimit = 5,
  onScopeChange,
  onSubmit,
  scope,
}: DocumentAiCommandBarProps) {
  const suggestionListId = useId();
  const [command, setCommand] = useState("");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [isSuggestionDismissed, setIsSuggestionDismissed] = useState(false);
  const [selectedReferences, setSelectedReferences] = useState<ResolvedAiDocumentReference[]>([]);
  const isDisabled = disabled || isAtCapacity;
  const trimmedCommand = command.trim();
  const mentionQuery = getActiveDocumentMentionQuery(command);
  const duplicateTitleCounts = useMemo(() => {
    return referenceCandidates.reduce<Map<string, number>>((counts, candidate) => {
      const normalizedTitle = candidate.title.toLocaleLowerCase();
      counts.set(normalizedTitle, (counts.get(normalizedTitle) ?? 0) + 1);
      return counts;
    }, new Map());
  }, [referenceCandidates]);
  const referenceSuggestions =
    mentionQuery === null || isDisabled || isSuggestionDismissed
      ? []
      : referenceCandidates
          .filter((candidate) => candidate.title.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase()))
          .slice(0, 6);
  const activeSuggestion = referenceSuggestions[activeSuggestionIndex] ?? referenceSuggestions[0] ?? null;
  const quickActions = isDisabled ? [] : messages.presets[scope] ?? [];
  const placeholder = isAtCapacity
    ? formatEditorMessage(messages.capacityReached, {
        count: String(runningCount),
        limit: String(runningLimit),
      })
    : disabled
      ? messages.noTarget
      : messages.placeholder;
  const selectReferenceSuggestion = (candidate: AiDocumentReferenceCandidate) => {
    setCommand((currentCommand) => replaceActiveMention(currentCommand, candidate.title));
    setSelectedReferences((currentReferences) => [
      ...currentReferences.filter((reference) => reference.title.toLocaleLowerCase() !== candidate.title.toLocaleLowerCase()),
      { id: candidate.id, title: candidate.title },
    ]);
    setActiveSuggestionIndex(0);
    setIsSuggestionDismissed(true);
  };

  return (
    <form
      aria-label={messages.inputLabel}
      className="pointer-events-auto mx-auto flex w-[min(40rem,calc(100%-2rem))] flex-col gap-2 rounded-2xl border border-zinc-200 bg-white px-2 py-2 shadow-xl shadow-zinc-950/15"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedCommand || isDisabled) return;

        const references = resolveSubmittedReferences(trimmedCommand, referenceCandidates, selectedReferences);
        onSubmit(trimmedCommand, references.length > 0 ? references : undefined);
        setCommand("");
        setSelectedReferences([]);
        setActiveSuggestionIndex(0);
        setIsSuggestionDismissed(false);
      }}
    >
      {quickActions.length > 0 ? (
        <div className="flex max-w-full gap-1 overflow-x-auto px-1 pb-0.5">
          {quickActions.map((preset) => (
            <button
              aria-label={formatEditorMessage(messages.quickAction, { command: preset.command })}
              className="inline-flex h-7 shrink-0 items-center rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-950"
              key={`${scope}-${preset.command}`}
              onClick={() => onSubmit(preset.command)}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
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
          aria-activedescendant={activeSuggestion ? getSuggestionElementId(suggestionListId, activeSuggestion.id) : undefined}
          aria-controls={referenceSuggestions.length > 0 ? suggestionListId : undefined}
          aria-expanded={referenceSuggestions.length > 0}
          aria-haspopup="listbox"
          className="min-w-0 flex-1 bg-transparent px-1 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
          disabled={isDisabled}
          onChange={(event) => {
            setCommand(event.currentTarget.value);
            setActiveSuggestionIndex(0);
            setIsSuggestionDismissed(false);
          }}
          onKeyDown={(event) => {
            if (referenceSuggestions.length === 0) return;

            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveSuggestionIndex((currentIndex) => (currentIndex + 1) % referenceSuggestions.length);
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestionIndex(
                (currentIndex) => (currentIndex - 1 + referenceSuggestions.length) % referenceSuggestions.length,
              );
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setIsSuggestionDismissed(true);
              return;
            }

            if (event.key === "Enter" && activeSuggestion) {
              event.preventDefault();
              selectReferenceSuggestion(activeSuggestion);
            }
          }}
          placeholder={placeholder}
          role="combobox"
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
      </div>
      {referenceSuggestions.length > 0 ? (
        <div
          aria-label={messages.referenceSuggestions}
          className="max-h-44 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
          id={suggestionListId}
          role="listbox"
        >
          {referenceSuggestions.map((candidate, index) => (
            <button
              aria-label={getReferenceSuggestionLabel(candidate, duplicateTitleCounts)}
              aria-selected={index === activeSuggestionIndex}
              className="flex w-full flex-col rounded-md px-2.5 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100"
              id={getSuggestionElementId(suggestionListId, candidate.id)}
              key={candidate.id}
              onClick={() => selectReferenceSuggestion(candidate)}
              role="option"
              type="button"
            >
              <span className="font-medium">{candidate.title}</span>
              {candidate.plainText ? (
                <span className="mt-0.5 line-clamp-1 text-xs text-zinc-500">{candidate.plainText}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}

function resolveSubmittedReferences(
  command: string,
  candidates: readonly AiDocumentReferenceCandidate[],
  selectedReferences: readonly ResolvedAiDocumentReference[],
) {
  const selectedInCommand = selectedReferences.filter((reference) => commandIncludesReference(command, reference));
  const parsedReferences = resolveAiDocumentReferences(command, candidates);
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();

  return [...selectedInCommand, ...parsedReferences].flatMap((reference) => {
    const normalizedTitle = reference.title.toLocaleLowerCase();
    if (seenIds.has(reference.id) || seenTitles.has(normalizedTitle)) {
      return [];
    }

    seenIds.add(reference.id);
    seenTitles.add(normalizedTitle);
    return [reference];
  });
}

function commandIncludesReference(command: string, reference: ResolvedAiDocumentReference) {
  const normalizedCommand = command.toLocaleLowerCase();
  const normalizedTitle = reference.title.toLocaleLowerCase();
  return normalizedCommand.includes(`@${normalizedTitle}`) || normalizedCommand.includes(`@"${normalizedTitle}"`);
}

function replaceActiveMention(command: string, title: string) {
  const lastAtIndex = command.lastIndexOf("@");
  if (lastAtIndex === -1) {
    return command;
  }

  return `${command.slice(0, lastAtIndex)}@${title}`;
}

function getReferenceSuggestionLabel(
  candidate: AiDocumentReferenceCandidate,
  duplicateTitleCounts: ReadonlyMap<string, number>,
) {
  const duplicateCount = duplicateTitleCounts.get(candidate.title.toLocaleLowerCase()) ?? 0;
  return duplicateCount > 1 ? `${candidate.title} (${candidate.id})` : candidate.title;
}

function getSuggestionElementId(listId: string, candidateId: string) {
  return `${listId}-${candidateId}`;
}
