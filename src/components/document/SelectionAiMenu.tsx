"use client";

import { BarChart3, Languages, Minimize2, Sparkles, Wand2 } from "lucide-react";
import type { CSSProperties } from "react";

type SelectionAiMenuSide = "top" | "bottom";

type SelectionAiMenuProps = {
  hasSelection: boolean;
  left?: number;
  onCommand: (command: string) => void;
  side?: SelectionAiMenuSide;
  selectedText?: string;
  top?: number;
};

const commands = [
  { command: "Improve clarity", icon: Wand2, label: "Improve" },
  { command: "Make concise", icon: Minimize2, label: "Concise" },
  { command: "Make more strategic", icon: Sparkles, label: "Strategic" },
  { command: "Strengthen evidence", icon: BarChart3, label: "Evidence" },
  { command: "Translate to Korean", icon: Languages, label: "Korean" },
  { command: "Translate to English", icon: Languages, label: "English" },
];

export function SelectionAiMenu({ hasSelection, left = 16, onCommand, side = "top", top = 16 }: SelectionAiMenuProps) {
  if (!hasSelection) return null;

  const style: CSSProperties = {
    left,
    top,
  };

  return (
    <div
      aria-label="Selection AI actions"
      className="absolute z-20 flex max-w-[calc(100%-2rem)] justify-center"
      data-side={side}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      style={style}
    >
      <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 rounded-md border border-zinc-200 bg-white/95 p-1 shadow-lg shadow-zinc-950/10 backdrop-blur">
        {commands.map(({ command, icon: Icon, label }) => (
          <button
            aria-label={command}
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-950"
            key={command}
            onClick={() => onCommand(command)}
            title={command}
            type="button"
          >
            <Icon aria-hidden="true" className="size-3.5" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
