export type ProposalApplyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "target_not_found" };

export function applyProposalToText(
  documentText: string,
  targetText: string,
  replacementText: string,
): ProposalApplyResult {
  if (!documentText.includes(targetText)) {
    return { ok: false, reason: "target_not_found" };
  }

  return {
    ok: true,
    text: documentText.replace(targetText, replacementText),
  };
}
