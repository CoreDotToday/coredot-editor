export type EditorPluginContributionType =
  | "blockAction"
  | "settingsSection"
  | "toolbarItem"
  | "workspacePanel";

export function invokeEditorPluginContribution<Result>(
  contributionType: EditorPluginContributionType,
  contributionId: string,
  operation: () => Result,
  fallback: Result,
): Result {
  try {
    return operation();
  } catch {
    reportEditorPluginContributionFailure(contributionType, contributionId);
    return fallback;
  }
}

export function reportEditorPluginContributionFailure(
  contributionType: EditorPluginContributionType,
  contributionId: string,
) {
  console.error("Editor plugin contribution failed.", {
    contributionId,
    contributionType,
  });
}
