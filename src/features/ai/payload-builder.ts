import type { AiCommandPayload, AiMessage } from "./types";

type BuildMessagesInput = Omit<AiCommandPayload, "documentId" | "templateId"> & {
  documentId?: string;
  systemPrompt: string;
  templateId?: string;
};

export function buildAiMessages(input: BuildMessagesInput): AiMessage[] {
  const variableLines = Object.entries(input.variables)
    .map(([key, value]) => `${key}: ${formatVariableValue(value)}`)
    .join("\n");

  const userContent = [
    `Command:\n${input.command}`,
    variableLines ? `Template variables:\n${variableLines}` : "Template variables:\nNone",
    input.beforeContext ? `Before context:\n${input.beforeContext}` : "",
    input.selectedText ? `Selected text:\n${input.selectedText}` : "",
    input.afterContext ? `After context:\n${input.afterContext}` : "",
    input.documentText ? `Document text:\n${input.documentText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userContent },
  ];
}

function formatVariableValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
