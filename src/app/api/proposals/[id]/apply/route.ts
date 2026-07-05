import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyProposalToDocumentDraft,
  type ProposalApplicationResult,
} from "@/features/proposals/proposal-application-service";

const proposalApplyPayloadSchema = z.object({
  appliedMode: z.enum(["replace", "insert_below"]),
  document: z.object({
    id: z.string().min(1),
  }),
  expectedDocumentContentSignature: z.string().min(1),
  expectedStatus: z.literal("pending").optional(),
});

type ProposalApplyRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: ProposalApplyRouteContext) {
  const result = proposalApplyPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await context.params;
  const application = await applyProposalToDocumentDraft({
    appliedMode: result.data.appliedMode,
    draft: result.data.document,
    expectedDocumentContentSignature: result.data.expectedDocumentContentSignature,
    expectedStatus: result.data.expectedStatus,
    proposalId: id,
  });

  return proposalApplicationResponse(application);
}

function proposalApplicationResponse(result: ProposalApplicationResult) {
  if (result.ok) {
    return NextResponse.json({ document: result.document, proposal: result.proposal });
  }

  if (result.error === "proposal_not_found") {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (result.error === "document_not_found") {
    return NextResponse.json({ error: "Document not found", proposal: result.proposal }, { status: 404 });
  }

  if (result.error === "document_mismatch") {
    return NextResponse.json(
      {
        error: "Proposal does not belong to the submitted document",
        proposal: result.proposal,
      },
      { status: 409 },
    );
  }

  if (result.error === "document_changed") {
    return NextResponse.json(
      {
        document: result.document,
        error: "Document changed before proposal application",
        proposal: result.proposal,
      },
      { status: 409 },
    );
  }

  if (result.error === "proposal_status_changed") {
    return NextResponse.json(
      {
        error: "Proposal status changed",
        proposal: result.proposal,
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      error: "Proposal could not be applied to the submitted document",
      reason: result.applyFailureReason,
      proposal: result.proposal,
    },
    { status: 409 },
  );
}
