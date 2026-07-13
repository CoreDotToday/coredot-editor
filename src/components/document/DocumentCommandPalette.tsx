"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ModalSurface } from "@/components/ui/ModalSurface";
import type {
  DocumentCommandAction,
  DocumentCommandGroup,
  DocumentCommandPaletteMessages,
} from "./commands/document-command-types";

type DocumentCommandPaletteProps = {
  actions: DocumentCommandAction[];
  messages: DocumentCommandPaletteMessages;
  onClose: () => void;
};

type CommandSearchResult = {
  action: DocumentCommandAction;
  score: number;
};

const GROUP_ORDER: DocumentCommandGroup[] = ["ai", "view", "document", "export"];

export function DocumentCommandPalette({ actions, messages, onClose }: DocumentCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const paletteId = useId();
  const visibleResults = useCommandSearchResults(actions, query);
  const groupedResults = groupCommandResults(visibleResults);
  const activeOptionId = visibleResults[selectedIndex]
    ? getCommandOptionId(paletteId, visibleResults[selectedIndex].action.id)
    : undefined;

  useEffect(() => {
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, visibleResults.length]);

  const executeSelectedCommand = () => {
    const selectedAction = visibleResults[selectedIndex]?.action;
    if (!selectedAction) return;

    onClose();
    selectedAction.execute();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (visibleResults.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((currentIndex) => (currentIndex + 1) % visibleResults.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((currentIndex) => (currentIndex - 1 + visibleResults.length) % visibleResults.length);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      executeSelectedCommand();
    }
  };

  let optionIndex = 0;

  return (
    <ModalSurface
      aria-label={messages.title}
      className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-hidden rounded-lg border border-zinc-200 bg-white p-0 shadow-2xl shadow-zinc-950/20"
      initialFocusRef={inputRef}
      onClose={onClose}
      overlayClassName="fixed inset-0 flex items-start justify-center bg-zinc-950/20 px-4 pt-[12vh]"
      unstyled
    >
        <div className="border-b border-zinc-200 p-3">
          <label className="sr-only" htmlFor="document-command-palette-query">
            {messages.searchLabel}
          </label>
          <input
            aria-label={messages.searchLabel}
            aria-activedescendant={activeOptionId}
            aria-controls={`${paletteId}-listbox`}
            autoComplete="off"
            autoCorrect="off"
            className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
            id="document-command-palette-query"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={messages.placeholder}
            ref={inputRef}
            spellCheck={false}
            type="text"
            value={query}
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2" id={`${paletteId}-listbox`} role="listbox">
          {visibleResults.length > 0 ? (
            groupedResults.map(({ group, results }) => (
              <section className="py-1" key={group}>
                <h2 className="px-3 py-1 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                  {messages.groups[group]}
                </h2>
                <div className="space-y-1">
                  {results.map(({ action }) => {
                    const currentIndex = optionIndex;
                    optionIndex += 1;

                    return (
                      <button
                        aria-selected={selectedIndex === currentIndex}
                        className={[
                          "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
                          selectedIndex === currentIndex
                            ? "bg-zinc-950 text-white"
                            : "text-zinc-800 hover:bg-zinc-100",
                        ].join(" ")}
                        id={getCommandOptionId(paletteId, action.id)}
                        key={action.id}
                        onClick={() => {
                          onClose();
                          action.execute();
                        }}
                        onMouseMove={() => setSelectedIndex(currentIndex)}
                        ref={(element) => {
                          optionRefs.current[currentIndex] = element;
                        }}
                        role="option"
                        type="button"
                      >
                        <span className="min-w-0 truncate">{action.label}</span>
                        {action.shortcut ? (
                          <span
                            className={[
                              "shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium",
                              selectedIndex === currentIndex
                                ? "border-white/30 text-white/80"
                                : "border-zinc-200 text-zinc-500",
                            ].join(" ")}
                          >
                            {action.shortcut}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">{messages.empty}</p>
          )}
        </div>
        <footer className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500">{messages.footerHint}</footer>
    </ModalSurface>
  );
}

export function useCommandSearchResults(actions: DocumentCommandAction[], query: string): CommandSearchResult[] {
  return useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    const enabledActions = actions.filter((action) => action.enabled !== false);

    if (!normalizedQuery) {
      return enabledActions.map((action, index) => ({
        action,
        score: GROUP_ORDER.indexOf(action.group) * 1000 + index,
      }));
    }

    return enabledActions
      .map((action) => ({
        action,
        score: getCommandMatchScore(action, normalizedQuery),
      }))
      .filter((result) => result.score < Number.POSITIVE_INFINITY)
      .sort((first, second) => first.score - second.score || first.action.label.localeCompare(second.action.label));
  }, [actions, query]);
}

function groupCommandResults(results: CommandSearchResult[]) {
  return GROUP_ORDER.map((group) => ({
    group,
    results: results.filter((result) => result.action.group === group),
  })).filter((groupedResult) => groupedResult.results.length > 0);
}

function getCommandMatchScore(action: DocumentCommandAction, normalizedQuery: string) {
  const searchFields = [action.label, action.group, ...action.keywords].map(normalizeSearchText);
  let bestScore = Number.POSITIVE_INFINITY;

  for (const field of searchFields) {
    if (!field) continue;
    if (field.includes(normalizedQuery)) {
      bestScore = Math.min(bestScore, field.indexOf(normalizedQuery));
      continue;
    }

    const fuzzyScore = getFuzzyMatchScore(field, normalizedQuery);
    if (fuzzyScore !== null) {
      bestScore = Math.min(bestScore, 100 + fuzzyScore);
    }
  }

  return bestScore;
}

function getFuzzyMatchScore(value: string, query: string) {
  let valueIndex = 0;
  let score = 0;

  for (const queryCharacter of query) {
    const nextIndex = value.indexOf(queryCharacter, valueIndex);
    if (nextIndex === -1) {
      return null;
    }

    score += nextIndex - valueIndex;
    valueIndex = nextIndex + 1;
  }

  return score + value.length - query.length;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getCommandOptionId(paletteId: string, commandId: string) {
  return `${paletteId}-option-${commandId}`;
}
