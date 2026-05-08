"use client";

import type { AiRunRecord } from "@/db/schema";

export type AiRunHistoryItem = Pick<AiRunRecord, "id" | "commandType" | "status" | "createdAt">;

type AiRunHistoryProps = {
  runs: AiRunHistoryItem[];
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatCommandType(commandType: AiRunHistoryItem["commandType"]) {
  return commandType.replace("_", " ");
}

function formatRunDate(value: Date | string | number) {
  return dateFormatter.format(new Date(value));
}

export function AiRunHistory({ runs }: AiRunHistoryProps) {
  return (
    <section className="px-4 py-5">
      <h2 className="text-sm font-semibold text-zinc-950">History</h2>
      {runs.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-zinc-500">No AI runs yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {runs.slice(0, 5).map((run) => (
            <li key={run.id} className="text-sm text-zinc-700">
              <div className="font-medium">{formatCommandType(run.commandType)}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {run.status} · {formatRunDate(run.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
