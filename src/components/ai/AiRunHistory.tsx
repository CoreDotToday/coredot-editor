"use client";

import type { AiRunRecord } from "@/db/schema";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  type EditorLanguage,
  type EditorMessages,
} from "@/features/i18n/editor-language";

export type AiRunHistoryItem = Pick<AiRunRecord, "id" | "commandType" | "status" | "createdAt">;

type AiRunHistoryProps = {
  hasMore?: boolean;
  isLoadingMore?: boolean;
  language?: EditorLanguage;
  messages?: EditorMessages["history"];
  onLoadMore?: () => void;
  runs: AiRunHistoryItem[];
};

function formatCommandType(commandType: AiRunHistoryItem["commandType"], messages: EditorMessages["history"]) {
  return messages.commandTypes[commandType] ?? commandType.replace("_", " ");
}

function formatRunDate(value: Date | string | number, language: EditorLanguage) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      dateTime: null,
      label: language === "ko" ? "유효하지 않은 날짜" : "Invalid date",
    };
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return {
    dateTime: date.toISOString(),
    label: language === "ko"
      ? `${year}. ${month}. ${day}. ${hours}:${minutes} UTC`
      : `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${hours}:${minutes} UTC`,
  };
}

export function AiRunHistory({
  hasMore = false,
  isLoadingMore = false,
  language = DEFAULT_EDITOR_LANGUAGE,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].history,
  onLoadMore,
  runs,
}: AiRunHistoryProps) {
  return (
    <section className="px-4 py-5">
      <h2 className="text-sm font-semibold text-zinc-950">{messages.title}</h2>
      {runs.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-zinc-500">{messages.empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {runs.map((run) => {
            const runDate = formatRunDate(run.createdAt, language);

            return (
              <li key={run.id} className="text-sm text-zinc-700">
                <div className="font-medium">{formatCommandType(run.commandType, messages)}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {(messages.statuses[run.status] ?? run.status)} ·{" "}
                  {runDate.dateTime
                    ? <time dateTime={runDate.dateTime}>{runDate.label}</time>
                    : <span>{runDate.label}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && onLoadMore ? (
        <button
          className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400"
          disabled={isLoadingMore}
          onClick={onLoadMore}
          type="button"
        >
          {isLoadingMore ? (language === "ko" ? "불러오는 중..." : "Loading...") : (language === "ko" ? "이전 실행 더 보기" : "Load older runs")}
        </button>
      ) : null}
    </section>
  );
}
