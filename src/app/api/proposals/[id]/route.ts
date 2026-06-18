import { NextResponse } from "next/server";
import { z } from "zod";
import { getProposalById, updateProposalStatus } from "@/features/proposals/proposal-repository";

const proposalStatusPayloadSchema = z.object({
  status: z.enum(["pending", "accepted", "rejected"]),
  appliedMode: z.enum(["replace", "insert_below"]).optional(),
  expectedStatus: z.enum(["pending", "accepted", "rejected"]).optional(),
});

type ProposalRouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, context: ProposalRouteContext) {
  const result = proposalStatusPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await context.params;
  const { appliedMode, expectedStatus, status } = result.data;
  const proposal = await updateProposalStatus(id, status, appliedMode, { expectedStatus });
  if (!proposal) {
    const existingProposal = await getProposalById(id);
    if (existingProposal) {
      return NextResponse.json(
        {
          error: expectedStatus && existingProposal.status !== expectedStatus
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
}
