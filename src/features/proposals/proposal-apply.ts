export type ProposalApplyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty_target" | "target_not_found" | "ambiguous_target" };

export type ProposalOccurrenceValidationResult =
  | { ok: true }
  | { ok: false; reason: "empty_target" | "target_not_found" | "ambiguous_target" };

export function applyProposalToText(
  documentText: string,
  targetText: string,
  replacementText: string,
): ProposalApplyResult {
  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  if (!documentText.includes(targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  if (documentText.indexOf(targetText) !== documentText.lastIndexOf(targetText)) {
    return { ok: false, reason: "ambiguous_target" };
  }

  return {
    ok: true,
    text: documentText.replace(targetText, replacementText),
  };
}

export function validateProposalTargetOccurrence(
  documentText: string,
  targetText: string,
  occurrenceIndex: number | undefined,
): ProposalOccurrenceValidationResult {
  if (occurrenceIndex === undefined) {
    const result = applyProposalToText(documentText, targetText, targetText);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  if (targetText === "") {
    return { ok: false, reason: "empty_target" };
  }

  const occurrenceCount = countOccurrences(documentText, targetText);
  if (occurrenceIndex < occurrenceCount) {
    return { ok: true };
  }

  return { ok: false, reason: "target_not_found" };
}

function countOccurrences(text: string, targetText: string) {
  let count = 0;
  let offset = text.indexOf(targetText);

  while (offset !== -1) {
    count += 1;
    offset = text.indexOf(targetText, offset + 1);
  }

  return count;
}
