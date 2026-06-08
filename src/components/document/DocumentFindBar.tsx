import { ChevronDown, ChevronUp, Regex, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatEditorMessage } from "@/features/i18n/editor-language";
import type { DocumentFindError } from "@/features/documents/document-find";

export type DocumentFindBarMessages = {
  caseSensitive: string;
  close: string;
  currentMatch: string;
  findLabel: string;
  findPlaceholder: string;
  next: string;
  noMatches: string;
  previous: string;
  regex: string;
  replace: string;
  replaceAll: string;
  replaceCurrent: string;
  replaceLabel: string;
  replacePlaceholder: string;
};

type DocumentFindBarProps = {
  activeIndex: number;
  caseSensitive: boolean;
  error: DocumentFindError | null;
  matchCount: number;
  messages: DocumentFindBarMessages;
  onCaseSensitiveChange: (enabled: boolean) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onQueryChange: (query: string) => void;
  onRegexChange: (enabled: boolean) => void;
  onReplaceAll: () => void;
  onReplaceCurrent: () => void;
  onReplaceTextChange: (replacement: string) => void;
  query: string;
  regex: boolean;
  replaceText: string;
};

export function DocumentFindBar({
  activeIndex,
  caseSensitive,
  error,
  matchCount,
  messages,
  onCaseSensitiveChange,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  onRegexChange,
  onReplaceAll,
  onReplaceCurrent,
  onReplaceTextChange,
  query,
  regex,
  replaceText,
}: DocumentFindBarProps) {
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const hasMatches = matchCount > 0;
  const matchStatus = error
    ? messages.noMatches
    : hasMatches
      ? formatEditorMessage(messages.currentMatch, {
          current: String(Math.min(activeIndex + 1, matchCount)),
          total: String(matchCount),
        })
      : messages.noMatches;

  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  }, []);

  return (
    <section
      aria-label={messages.findLabel}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2"
    >
      <div className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2">
        <Search aria-hidden="true" className="size-4 shrink-0 text-zinc-500" />
        <input
          aria-label={messages.findLabel}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={messages.findPlaceholder}
          ref={queryInputRef}
          role="searchbox"
          type="search"
          value={query}
        />
        <span className="shrink-0 text-xs font-medium text-zinc-500">{matchStatus}</span>
      </div>
      <div className="flex items-center gap-1">
        <IconButton disabled={!hasMatches} icon={ChevronUp} label={messages.previous} onClick={onPrevious} />
        <IconButton disabled={!hasMatches} icon={ChevronDown} label={messages.next} onClick={onNext} />
      </div>
      <label className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-zinc-600 hover:bg-white">
        <input
          aria-label={messages.caseSensitive}
          checked={caseSensitive}
          className="size-3.5"
          onChange={(event) => onCaseSensitiveChange(event.currentTarget.checked)}
          type="checkbox"
        />
        Aa
        <span className="sr-only">{messages.caseSensitive}</span>
      </label>
      <label className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-zinc-600 hover:bg-white">
        <input
          aria-label={messages.regex}
          checked={regex}
          className="size-3.5"
          onChange={(event) => onRegexChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <Regex aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{messages.regex}</span>
      </label>
      <div className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2">
        <input
          aria-label={messages.replaceLabel}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
          onChange={(event) => onReplaceTextChange(event.currentTarget.value)}
          placeholder={messages.replacePlaceholder}
          type="text"
          value={replaceText}
        />
      </div>
      <button
        className="inline-flex h-8 items-center rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300"
        disabled={!hasMatches}
        onClick={onReplaceCurrent}
        type="button"
      >
        {messages.replaceCurrent}
      </button>
      <button
        className="inline-flex h-8 items-center rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300"
        disabled={!hasMatches}
        onClick={onReplaceAll}
        type="button"
      >
        {messages.replaceAll}
      </button>
      <IconButton icon={X} label={messages.close} onClick={onClose} />
    </section>
  );
}

function IconButton({
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: typeof Search;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-md text-zinc-600 hover:bg-white hover:text-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-300"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
