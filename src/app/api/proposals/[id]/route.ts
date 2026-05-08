import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProposalStatus } from "@/features/proposals/proposal-repository";

const proposalStatusPayloadSchema = z.object({
  status: z.enum(["pending", "accepted", "rejected"]),
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
  const proposal = await updateProposalStatus(id, result.data.status);
  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  return NextResponse.json({ proposal });
}
