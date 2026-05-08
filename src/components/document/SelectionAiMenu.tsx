"use client";

type SelectionAiMenuProps = {
  hasSelection: boolean;
  onCommand: (command: string) => void;
};

const commands = ["Improve clarity", "Make concise", "Make more strategic", "Strengthen evidence"];

export function SelectionAiMenu({ hasSelection, onCommand }: SelectionAiMenuProps) {
  if (!hasSelection) return null;

  return (
    <div className="flex flex-wrap gap-2 border-b border-neutral-200 bg-white px-4 py-3">
      {commands.map((command) => (
        <button
          className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
          key={command}
          onClick={() => onCommand(command)}
          type="button"
        >
          {command}
        </button>
      ))}
    </div>
  );
}
