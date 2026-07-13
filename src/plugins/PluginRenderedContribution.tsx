"use client";

import { Component, type ReactNode } from "react";
import {
  reportEditorPluginContributionFailure,
  type EditorPluginContributionType,
} from "./contribution-safety";

type PluginRenderedContributionProps = {
  contributionId: string;
  contributionType: EditorPluginContributionType;
  render: () => ReactNode;
};

type PluginRenderedContributionState = { failed: boolean };

function ContributionContent({ render }: Pick<PluginRenderedContributionProps, "render">) {
  return render();
}

class PluginErrorSanitizer extends Component<{ children: ReactNode }> {
  static getDerivedStateFromError(): never {
    throw new Error("Editor plugin render failed.");
  }

  render() {
    return this.props.children;
  }
}

export class PluginRenderedContribution extends Component<
  PluginRenderedContributionProps,
  PluginRenderedContributionState
> {
  state: PluginRenderedContributionState = { failed: false };

  static getDerivedStateFromError(): PluginRenderedContributionState {
    return { failed: true };
  }

  componentDidCatch() {
    reportEditorPluginContributionFailure(
      this.props.contributionType,
      this.props.contributionId,
    );
  }

  componentDidUpdate(previousProps: PluginRenderedContributionProps) {
    if (
      this.state.failed &&
      (previousProps.contributionId !== this.props.contributionId ||
        previousProps.contributionType !== this.props.contributionType ||
        previousProps.render !== this.props.render)
    ) {
      this.setState({ failed: false });
    }
  }

  render() {
    return (
      <div
        className="contents"
        data-plugin-contribution-id={this.props.contributionId}
      >
        {this.state.failed ? null : (
          <PluginErrorSanitizer>
            <ContributionContent render={this.props.render} />
          </PluginErrorSanitizer>
        )}
      </div>
    );
  }
}
