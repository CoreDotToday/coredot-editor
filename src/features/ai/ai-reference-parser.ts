export type AiDocumentReferenceCandidate = {
  id: string;
  plainText: string;
  title: string;
  updatedAt?: Date;
};

export type ResolvedAiDocumentReference = {
  id: string;
  title: string;
};

export function resolveAiDocumentReferences(
  command: string,
  candidates: readonly AiDocumentReferenceCandidate[],
): ResolvedAiDocumentReference[] {
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  const references: ResolvedAiDocumentReference[] = [];
  const matches = findDocumentMentionMatches(command, candidates);

  for (const match of matches) {
    const normalizedTitle = match.title.toLocaleLowerCase();
    if (seen.has(match.id) || seenTitles.has(normalizedTitle)) {
      continue;
    }

    seen.add(match.id);
    seenTitles.add(normalizedTitle);
    references.push({
      id: match.id,
      title: match.title,
    });
  }

  return references;
}

export function getActiveDocumentMentionQuery(command: string): string | null {
  const lastAtIndex = command.lastIndexOf("@");
  if (lastAtIndex === -1) {
    return null;
  }

  const query = command.slice(lastAtIndex + 1);
  if (/[\n,;]/.test(query)) {
    return null;
  }

  return query.replace(/^"/, "").trimStart();
}

function findDocumentMentionMatches(command: string, candidates: readonly AiDocumentReferenceCandidate[]) {
  const matches: ResolvedAiDocumentReference[] = [];
  const sortedCandidates = [...candidates].sort((a, b) => b.title.length - a.title.length);

  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== "@") {
      continue;
    }

    const quotedMatch = findQuotedMentionMatch(command, index, candidates);
    if (quotedMatch) {
      matches.push(quotedMatch);
      continue;
    }

    const candidate = sortedCandidates.find((item) => mentionMatchesCandidate(command, index, item.title));
    if (candidate) {
      matches.push({ id: candidate.id, title: candidate.title });
    }
  }

  return matches;
}

function findQuotedMentionMatch(
  command: string,
  atIndex: number,
  candidates: readonly AiDocumentReferenceCandidate[],
): ResolvedAiDocumentReference | null {
  if (command[atIndex + 1] !== "\"") {
    return null;
  }

  const closingQuoteIndex = command.indexOf("\"", atIndex + 2);
  if (closingQuoteIndex === -1) {
    return null;
  }

  const title = command.slice(atIndex + 2, closingQuoteIndex).toLocaleLowerCase();
  const candidate = candidates.find((item) => item.title.toLocaleLowerCase() === title);

  return candidate ? { id: candidate.id, title: candidate.title } : null;
}

function mentionMatchesCandidate(command: string, atIndex: number, title: string) {
  const normalizedCommand = command.toLocaleLowerCase();
  const normalizedTitle = title.toLocaleLowerCase();
  const mentionStartIndex = atIndex + 1;

  return (
    normalizedCommand.startsWith(normalizedTitle, mentionStartIndex) &&
    isMentionBoundary(command, mentionStartIndex + title.length)
  );
}

const mentionBoundaryWords = new Set([
  "and",
  "as",
  "against",
  "based",
  "compare",
  "for",
  "from",
  "in",
  "on",
  "review",
  "summarize",
  "then",
  "to",
  "use",
  "using",
  "with",
]);

function isMentionBoundary(command: string, endIndex: number) {
  if (endIndex >= command.length) {
    return true;
  }

  const nextChar = command[endIndex];
  if (/[,;.!?)\]\n]/.test(nextChar)) {
    return true;
  }

  if (!/\s/.test(nextChar)) {
    return false;
  }

  const rest = command.slice(endIndex).trimStart();
  if (!rest || rest.startsWith("@")) {
    return true;
  }

  const nextWord = rest.match(/^[\p{L}\p{N}_-]+/u)?.[0].toLocaleLowerCase();
  return nextWord ? mentionBoundaryWords.has(nextWord) : true;
}
