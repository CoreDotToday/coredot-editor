export type RedlineSegment = {
  text: string;
  type: "equal" | "deleted" | "inserted";
};

export function createRedlineSegments(originalText: string, replacementText: string): RedlineSegment[] {
  if (originalText === replacementText) {
    return originalText ? [{ type: "equal", text: originalText }] : [];
  }

  const originalTokens = tokenize(originalText);
  const replacementTokens = tokenize(replacementText);
  const segments: RedlineSegment[] = [];
  let prefixLength = 0;

  while (
    prefixLength < originalTokens.length &&
    prefixLength < replacementTokens.length &&
    originalTokens[prefixLength] === replacementTokens[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < originalTokens.length - prefixLength &&
    suffixLength < replacementTokens.length - prefixLength &&
    originalTokens[originalTokens.length - suffixLength - 1] === replacementTokens[replacementTokens.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  pushSegment(segments, "equal", originalTokens.slice(0, prefixLength).join(""));
  pushSegment(segments, "inserted", replacementTokens.slice(prefixLength, replacementTokens.length - suffixLength).join(""));
  pushSegment(segments, "deleted", originalTokens.slice(prefixLength, originalTokens.length - suffixLength).join(""));
  pushSegment(segments, "equal", originalTokens.slice(originalTokens.length - suffixLength).join(""));

  return segments.filter((segment) => segment.text.length > 0);
}

function tokenize(text: string) {
  return text.match(/\s+|[A-Za-z0-9]+|[^\sA-Za-z0-9]+/g) ?? [];
}

function pushSegment(segments: RedlineSegment[], type: RedlineSegment["type"], text: string) {
  const previousSegment = segments.at(-1);
  if (previousSegment?.type === type) {
    previousSegment.text += text;
    return;
  }

  segments.push({ type, text });
}
