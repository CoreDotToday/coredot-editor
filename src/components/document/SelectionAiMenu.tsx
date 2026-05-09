"use client";

import { BarChart3, Minimize2, Sparkles, Wand2 } from "lucide-react";
import type { CSSProperties } from "react";

type SelectionAiMenuProps = {
  hasSelection: boolean;
  left?: number;
  onCommand: (command: string) => void;
  selectedText?: string;
  top?: number;
};

const commands = [
  { command: "Improve clarity", icon: Wand2, label: "Improve" },
  { command: "Make concise", icon: Minimize2, label: "Concise" },
  { command: "Make more strategic", icon: Sparkles, label: "Strategic" },
  { command: "Strengthen evidence", icon: BarChart3, label: "Evidence" },
];

export function SelectionAiMenu({ hasSelection, left = 16, onCommand, selectedText = "", top = 16 }: SelectionAiMenuProps) {
  if (!hasSelection) return null;

  const style: CSSProperties = {
    left,
    top,
  };

  return (
    <div
      aria-label="Selection AI actions"
      className="absolute z-20 w-[min(32rem,calc(100%-2rem))] rounded-lg border border-zinc-200 bg-white/95 p-2 shadow-lg shadow-zinc-950/10 backdrop-blur"
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      style={style}
    >
      <div className="mb-2 truncate border-b border-zinc-100 px-2 pb-2 text-xs text-zinc-500">
        {selectedText || "Selected text"}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {commands.map(({ command, icon: Icon, label }) => (
          <button
            aria-label={command}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-950"
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
