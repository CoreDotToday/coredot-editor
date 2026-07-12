import { NextResponse } from "next/server";
import { aiCommandPayloadSchema, type ReviewResult } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import { completeAiRunWithProposals, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { prepareAiCommandRequest, type AiCommandRequestFailure } from "@/features/ai/ai-command-service";
import { applyProposalToText } from "@/features/proposals/proposal-apply";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
  withOperationTimeout,
} from "@/features/security/resource-policy";

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();

  let payload: unknown;
  try {
    payload = await parseBoundedJson(request);
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    payload = null;
  }
  const result = aiCommandPayloadSchema.safeParse(payload);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  const hasSubmittedDocumentText =
    typeof payload === "object" && payload !== null && Object.hasOwn(payload, "documentText");
  const prepared = await prepareAiCommandRequest(
    context,
    {
      payload: body,
      useSubmittedDocumentText: hasSubmittedDocumentText,
    },
  );
  if (!prepared.ok) {
    return aiCommandFailureResponse(prepared);
  }

  const { document, provider, referencedDocuments, reviewedText, template } = prepared;

  const run = await createAiRun(context, {
    documentId: document.id,
    promptTemplateId: template.id,
    commandType: "document_review",
    provider: provider.name,
    model: provider.model,
    inputSummaryJson: {
      command: body.command,
      documentTextLength: reviewedText.length,
      referencedDocumentIds: referencedDocuments.map((reference) => reference.id),
      variableNames: Object.keys(body.variables),
    },
  });

  try {
    const messages = buildAiMessages({
      ...body,
      documentText: reviewedText,
      referencedDocuments,
      systemPrompt: template.systemPrompt,
    });
    const review = await withOperationTimeout((abortSignal) => provider.generateReview({ messages, abortSignal }));
    const validFindings = review.findings
      .map((finding) => ({
        finding,
        occurrenceIndex: getUniqueOccurrenceIndex(reviewedText, finding.targetText),
      }))
      .filter(({ finding, occurrenceIndex }) =>
        occurrenceIndex !== null && applyProposalToText(reviewedText, finding.targetText, finding.replacementText).ok,
      );
    const skippedProposalCount = review.findings.length - validFindings.length;

    const outputText = JSON.stringify(review);
    const finalizedRun = await completeAiRunWithProposals(
      context,
      run.id,
      outputText,
      validFindings.map(({ finding, occurrenceIndex }) => ({
        documentId: document.id,
        occurrenceIndex,
        targetText: finding.targetText,
        replacementText: finding.replacementText,
        explanation: formatFindingExplanation(finding),
      })),
    );

    return NextResponse.json({
      run: finalizedRun?.run ?? run,
      review,
      proposals: finalizedRun?.proposals ?? [],
      skippedProposalCount,
    });
  } catch (error) {
    await failAiRun(context, run.id, error instanceof Error ? error.message : "Unknown AI generation failure");
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "ai.review") });

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}

function aiCommandFailureResponse(failure: AiCommandRequestFailure) {
  return NextResponse.json(
    {
      ...(failure.details ? { details: failure.details } : {}),
      error: failure.error,
    },
    { status: failure.status },
  );
}

function formatFindingExplanation(finding: ReviewResult["findings"][number]): string {
  return `${finding.problem}: ${finding.reason}`;
}

function getUniqueOccurrenceIndex(documentText: string, targetText: string) {
  if (!targetText) {
    return null;
  }

  const firstIndex = documentText.indexOf(targetText);
  if (firstIndex === -1 || firstIndex !== documentText.lastIndexOf(targetText)) {
    return null;
  }

  return 0;
}
