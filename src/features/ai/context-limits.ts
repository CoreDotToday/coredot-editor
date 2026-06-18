export const AI_CONTEXT_LIMITS = {
  afterContextMaxCharacters: 20_000,
  beforeContextMaxCharacters: 20_000,
  commandMaxCharacters: 4_000,
  documentTextMaxCharacters: 2_000_000,
  maxReferenceDocuments: 8,
  providerDocumentTextMaxCharacters: 120_000,
  providerReferenceTextMaxCharacters: 40_000,
  selectedTextMaxCharacters: 100_000,
  variableNameMaxCharacters: 80,
  variableTotalMaxCharacters: 60_000,
  variableValueMaxCharacters: 20_000,
} as const;

export function truncateAiContextText(text: string, maxCharacters: number) {
  if (text.length <= maxCharacters) {
    return text;
  }

  const omittedCharacters = text.length - maxCharacters;
  return `${text.slice(0, maxCharacters)}\n[truncated ${omittedCharacters} characters]`;
}
