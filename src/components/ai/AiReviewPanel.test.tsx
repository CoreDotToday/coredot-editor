import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AiReviewPanel, type AiReviewProposal } from "./AiReviewPanel";

const proposals = [
  {
    id: "proposal_1",
    targetText: "growth was good",
    replacementText: "revenue grew 8%",
    explanation: "Unclear metric: Specificity helps review.",
    status: "pending",
  },
  {
    id: "proposal_2",
    targetText: "someone should follow up",
    replacementText: "Sales Ops should follow up",
    explanation: "Weak owner: Ownership helps execution.",
    status: "accepted",
  },
  {
    id: "proposal_3",
    targetText: "missing source",
    replacementText: "cite CRM export",
    explanation: "Missing source: Evidence helps.",
    status: "rejected",
  },
] satisfies AiReviewProposal[];

describe("AiReviewPanel", () => {
  it("renders pending, accepted, and rejected proposals", () => {
    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={proposals}
        selectedTemplateName="Board review"
      />,
    );

    expect(screen.getByText("growth was good")).toBeInTheDocument();
    expect(screen.getByText("revenue grew 8%")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("requests explicit proposal apply actions from action buttons", async () => {
    const user = userEvent.setup();
    const onUpdateProposalStatus = vi.fn();

    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={onUpdateProposalStatus}
        proposals={proposals}
        selectedTemplateName="Board review"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Replace proposal for growth was good" }));
    await user.click(screen.getByRole("button", { name: "Insert below proposal for growth was good" }));
    await user.click(screen.getByRole("button", { name: "Reject proposal for growth was good" }));

    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(1, "proposal_1", "accepted", "replace");
    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(2, "proposal_1", "accepted", "insert_below");
    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(3, "proposal_1", "rejected");
  });
});
