"use client";

import { createRedlineSegments } from "@/features/proposals/redline-diff";

type ProposalRedlineMessages = {
  added: string;
  deleted: string;
  redlinePreview: string;
};

type ProposalRedlineProps = {
  messages: ProposalRedlineMessages;
  originalText: string;
  replacementText: string;
};

export function ProposalRedline({ messages, originalText, replacementText }: ProposalRedlineProps) {
  const segments = createRedlineSegments(originalText, replacementText);

  if (segments.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={`${messages.redlinePreview}: ${originalText}`}
      className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2"
    >
      <p className="text-xs font-medium uppercase tracking-normal text-zinc-500">{messages.redlinePreview}</p>
      <p className="mt-1 text-sm leading-6 text-zinc-800">
        {segments.map((segment, index) => {
          if (segment.type === "deleted") {
            return (
              <span key={`${segment.type}-${index}`} className="mx-0.5 inline-flex items-baseline gap-1">
                <span className="rounded bg-rose-50 px-1 text-[0.7rem] font-medium text-rose-700">
                  {messages.deleted}
                </span>
                <del className="rounded bg-rose-50 px-1 text-rose-700 decoration-rose-700">{segment.text}</del>
              </span>
            );
          }

          if (segment.type === "inserted") {
            return (
              <span key={`${segment.type}-${index}`} className="mx-0.5 inline-flex items-baseline gap-1">
                <span className="rounded bg-sky-50 px-1 text-[0.7rem] font-medium text-sky-700">
                  {messages.added}
                </span>
                <ins className="rounded bg-sky-50 px-1 text-sky-700 no-underline">{segment.text}</ins>
              </span>
            );
          }

          return <span key={`${segment.type}-${index}`}>{segment.text}</span>;
        })}
      </p>
    </div>
  );
}
