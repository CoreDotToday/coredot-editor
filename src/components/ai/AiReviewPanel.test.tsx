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

    expect(screen.getAllByText("growth was good").length).toBeGreaterThan(0);
    expect(screen.getAllByText("revenue grew 8%").length).toBeGreaterThan(0);
    expect(screen.getByText("대기 중")).toBeInTheDocument();
    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.getByText("거절됨")).toBeInTheDocument();
  });

  it("shows the latest review summary and skipped finding count", () => {
    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={proposals.slice(0, 1)}
        reviewSummary={{
          findingCount: 3,
          proposalCount: 1,
          skippedProposalCount: 2,
          summary: "Three issues found, one safe edit created.",
        }}
        selectedTemplateName="Board review"
      />,
    );

    expect(screen.getByText("검토 요약")).toBeInTheDocument();
    expect(screen.getByText("Three issues found, one safe edit created.")).toBeInTheDocument();
    expect(screen.getByText("적용 가능한 제안 1개 · 제외된 제안 2개")).toBeInTheDocument();
  });

  it("shows an empty completed review state when no proposals were needed", () => {
    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={[]}
        reviewSummary={{
          findingCount: 0,
          proposalCount: 0,
          skippedProposalCount: 0,
          summary: "No high-confidence issues.",
        }}
        selectedTemplateName="Board review"
      />,
    );

    expect(screen.getByText("검토가 완료되었고 적용 가능한 제안은 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("아직 검토 제안이 없습니다.")).not.toBeInTheDocument();
  });

  it("keeps review summary counts as a snapshot instead of live proposal length", () => {
    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={proposals.slice(0, 2)}
        reviewSummary={{
          findingCount: 3,
          proposalCount: 1,
          skippedProposalCount: 2,
          summary: "One safe edit was created.",
        }}
        selectedTemplateName="Board review"
      />,
    );

    expect(screen.getByText("적용 가능한 제안 1개 · 제외된 제안 2개")).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.click(screen.getByRole("button", { name: "growth was good 제안을 아래에 추가" }));
    await user.click(screen.getByRole("button", { name: "growth was good 제안 거절" }));

    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(1, "proposal_1", "accepted", "replace");
    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(2, "proposal_1", "accepted", "insert_below");
    expect(onUpdateProposalStatus).toHaveBeenNthCalledWith(3, "proposal_1", "rejected");
  });

  it("requests bulk accept and reject actions for pending proposals", async () => {
    const user = userEvent.setup();
    const onBulkUpdateProposalStatus = vi.fn();

    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onBulkUpdateProposalStatus={onBulkUpdateProposalStatus}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={proposals}
        selectedTemplateName="Board review"
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));
    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 거절" }));

    expect(onBulkUpdateProposalStatus).toHaveBeenNthCalledWith(1, "accepted");
    expect(onBulkUpdateProposalStatus).toHaveBeenNthCalledWith(2, "rejected");
  });

  it("labels insert-below proposal history differently from replacement edits", () => {
    render(
      <AiReviewPanel
        errorMessage=""
        isReviewing={false}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={[
          {
            id: "proposal_insert",
            targetText: "Revenue retention needs clearer evidence.",
            replacementText: "매출 유지율은 더 명확한 근거가 필요합니다.",
            explanation: "Translation.",
            source: "selection",
            command: "Translate to Korean",
            defaultApplyMode: "insert_below",
            appliedMode: "insert_below",
            status: "accepted",
          },
        ]}
        selectedTemplateName="Board review"
      />,
    );

    expect(screen.getByText("아래 위치:")).toBeInTheDocument();
    expect(screen.getByText("추가된 내용:")).toBeInTheDocument();
    expect(screen.queryByText("바꿀 내용:")).not.toBeInTheDocument();
  });

  it("renders contract-style redline previews and can focus the source text", async () => {
    const user = userEvent.setup();
    const onFocusProposal = vi.fn();

    render(
      <AiReviewPanel
        activeProposalId="proposal_contract"
        errorMessage=""
        isReviewing={false}
        onFocusProposal={onFocusProposal}
        onReviewDocument={() => undefined}
        onUpdateProposalStatus={() => undefined}
        proposals={[
          {
            id: "proposal_contract",
            targetText: "Company may use Customer Data to improve services.",
            replacementText: "Company may use Customer Data only to provide the Services.",
            explanation: "Data use risk: Narrow secondary use.",
            source: "review",
            status: "pending",
          },
        ]}
        selectedTemplateName="Contract Review"
      />,
    );

    expect(screen.getByLabelText("레드라인 미리보기: Company may use Customer Data to improve services.")).toBeInTheDocument();
    expect(screen.getByText("삭제")).toBeInTheDocument();
    expect(screen.getByText("to improve services")).toBeInTheDocument();
    expect(screen.getByText("추가")).toBeInTheDocument();
    expect(screen.getByText("only to provide the Services")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Company may use Customer Data to improve services. 제안을 본문에서 보기",
      }),
    );

    expect(onFocusProposal).toHaveBeenCalledWith("proposal_contract");
  });
});
