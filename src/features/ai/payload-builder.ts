import type { AiCommandPayload, AiMessage } from "./types";
import { AI_CONTEXT_LIMITS, truncateAiContextText } from "./context-limits";

type BuildMessagesInput = Omit<AiCommandPayload, "documentId" | "references" | "templateId"> & {
  documentId?: string;
  referencedDocuments?: Array<{
    id: string;
    text: string;
    title: string;
  }>;
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
    input.referencedDocuments?.length
      ? `Referenced documents:\n${JSON.stringify(
          input.referencedDocuments.map((document) => ({
            id: document.id,
            title: document.title,
            text: truncateAiContextText(document.text, AI_CONTEXT_LIMITS.providerReferenceTextMaxCharacters),
          })),
          null,
          2,
        )}`
      : "",
    input.documentText
      ? `Document text:\n${truncateAiContextText(
          input.documentText,
          AI_CONTEXT_LIMITS.providerDocumentTextMaxCharacters,
        )}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userContent },
  ];
}

function formatVariableValue(value: unknown): string {
  const formatted = typeof value === "string" ? value : JSON.stringify(value);
  return truncateAiContextText(formatted ?? "", AI_CONTEXT_LIMITS.variableValueMaxCharacters);
}
