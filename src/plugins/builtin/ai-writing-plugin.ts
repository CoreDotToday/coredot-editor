import type { EditorMessages } from "@/features/i18n/editor-language";
import type { EditorPlugin, EditorSelectionCommand } from "../types";

export const aiWritingPlugin: EditorPlugin = {
  dependencies: ["core.document"],
  id: "ai.writing",
  name: "AI writing commands",
  selectionCommands: ({ messages }) => createDefaultSelectionCommands(messages),
  version: "0.1.0",
};

export function createDefaultSelectionCommands(messages: EditorMessages): EditorSelectionCommand[] {
  const commandMessages = messages.selectionMenu.commands;

  return [
    {
      ariaLabel: commandMessages.improveClarity.ariaLabel,
      command: "Improve clarity",
      icon: "wand",
      id: "ai.improve_clarity",
      label: commandMessages.improveClarity.label,
    },
    {
      ariaLabel: commandMessages.makeConcise.ariaLabel,
      command: "Make concise",
      icon: "minimize",
      id: "ai.make_concise",
      label: commandMessages.makeConcise.label,
    },
    {
      ariaLabel: commandMessages.makeStrategic.ariaLabel,
      command: "Make more strategic",
      icon: "sparkles",
      id: "ai.make_strategic",
      label: commandMessages.makeStrategic.label,
    },
    {
      ariaLabel: commandMessages.strengthenEvidence.ariaLabel,
      command: "Strengthen evidence",
      icon: "bar-chart",
      id: "ai.strengthen_evidence",
      label: commandMessages.strengthenEvidence.label,
    },
    {
      ariaLabel: commandMessages.continueWriting.ariaLabel,
      command: "Continue writing",
      icon: "pen-line",
      id: "ai.continue_writing",
      label: commandMessages.continueWriting.label,
    },
    {
      ariaLabel: commandMessages.translateKorean.ariaLabel,
      command: "Translate to Korean",
      icon: "languages",
      id: "ai.translate_ko",
      label: commandMessages.translateKorean.label,
    },
    {
      ariaLabel: commandMessages.translateEnglish.ariaLabel,
      command: "Translate to English",
      icon: "languages",
      id: "ai.translate_en",
      label: commandMessages.translateEnglish.label,
    },
  ];
}
