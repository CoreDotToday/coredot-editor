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
  language?: EditorLanguage;
  messages?: EditorMessages["history"];
  runs: AiRunHistoryItem[];
};

function formatCommandType(commandType: AiRunHistoryItem["commandType"], messages: EditorMessages["history"]) {
  return messages.commandTypes[commandType] ?? commandType.replace("_", " ");
}

function formatRunDate(value: Date | string | number, language: EditorLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AiRunHistory({
  language = DEFAULT_EDITOR_LANGUAGE,
  messages = editorMessages[DEFAULT_EDITOR_LANGUAGE].history,
  runs,
}: AiRunHistoryProps) {
  return (
    <section className="px-4 py-5">
      <h2 className="text-sm font-semibold text-zinc-950">{messages.title}</h2>
      {runs.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-zinc-500">{messages.empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {runs.slice(0, 5).map((run) => (
            <li key={run.id} className="text-sm text-zinc-700">
              <div className="font-medium">{formatCommandType(run.commandType, messages)}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {(messages.statuses[run.status] ?? run.status)} · {formatRunDate(run.createdAt, language)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
