export type ProposalApplyResult =
  | { ok: true; text: string }
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
