import { NextResponse } from "next/server";
import { z } from "zod";
import { getProposalById, updateProposalStatus } from "@/features/proposals/proposal-repository";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { ProposalStatusUpdateConflictError } from "@/features/proposals/proposal-status-errors";

const proposalStatusPayloadSchema = z.object({
  status: z.enum(["pending", "accepted", "rejected"]),
  appliedMode: z.enum(["replace", "insert_below"]).optional(),
  expectedStatus: z.enum(["pending", "accepted", "rejected"]).optional(),
});

type ProposalRouteContext = {
  params: Promise<{ id: string }>;
};

const optionsHandler = createProtectedOptionsHandler(["GET", "PATCH"]);
const getHandler = createProtectedRouteHandler(async (requestContext, _request: Request, context: ProposalRouteContext) => {
  const { id } = await context.params;
  const proposal = await getProposalById(requestContext, id);
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  return NextResponse.json({
    proposal: {
      appliedMode: proposal.appliedMode,
      command: proposal.command,
      defaultApplyMode: proposal.defaultApplyMode,
      explanation: proposal.explanation,
      id: proposal.id,
      occurrenceIndex: proposal.occurrenceIndex,
      replacementText: proposal.replacementText,
      source: proposal.source,
      status: proposal.status,
      targetFrom: proposal.targetFrom,
      targetText: proposal.targetText,
      targetTo: proposal.targetTo,
    },
  });
});
const patchHandler = createProtectedRouteHandler(async (
  requestContext,
  request: Request,
  context: ProposalRouteContext,
) => {
  const result = proposalStatusPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await context.params;
  const { appliedMode, expectedStatus, status } = result.data;
  if (status === "accepted") {
    return NextResponse.json({ error: "Use proposal apply endpoint for accepted proposals" }, { status: 400 });
  }

  let proposal;
  try {
    proposal = await updateProposalStatus(requestContext, id, status, appliedMode, { expectedStatus });
  } catch (error) {
    if (!(error instanceof ProposalStatusUpdateConflictError)) throw error;
    const existingProposal = await getProposalById(requestContext, id);
    return NextResponse.json(
      {
        error: error.message,
        proposal: existingProposal,
        reason: error.reason,
      },
      { status: 409 },
    );
  }
  if (!proposal) {
    const existingProposal = await getProposalById(requestContext, id);
    if (existingProposal) {
      return NextResponse.json(
        {
          error: existingProposal.status === "accepted"
            ? "Accepted proposals may only be reset by document change undo"
            : expectedStatus && existingProposal.status !== expectedStatus
              ? "Proposal status changed"
              : "Proposal update conflict",
          proposal: existingProposal,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  return NextResponse.json({ proposal });
});

export async function PATCH(request: Request, context: ProposalRouteContext) {
  return patchHandler(request, context);
}

export async function GET(request: Request, context: ProposalRouteContext) {
  return getHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
