import { NextResponse } from "next/server";
import type { AiProposalRecord } from "@/db/schema";
import { aiCommandPayloadSchema, reviewResultSchema, type ReviewResult } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import {
  claimAiRun,
  completeAiRunWithProposals,
  failAiRun,
  getAiRunByIdempotencyKey,
} from "@/features/ai/ai-run-repository";
import {
  createAiProviderForCommand,
  prepareAiCommandRequest,
  type PreparedAiCommandContext,
} from "@/features/ai/ai-command-service";
import {
  admitAiOperation,
  createAiOperationFingerprint,
  executeAiOperation,
  resolveAiIdempotencyKey,
  toPublicAiRun,
  type AiExecutionResult,
  type DurableAiOperation,
} from "@/features/ai/ai-execution";
import { applyProposalToText } from "@/features/proposals/proposal-apply";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  RESOURCE_LIMITS,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
} from "@/features/security/resource-policy";

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();

  const idempotency = resolveAiIdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return NextResponse.json({ error: idempotency.error }, { status: idempotency.status });
  }
  const admitted = await admitAiOperation({
    admitRequest: () => enforceRequestBudget(context, "ai.review"),
    deadlineMs: RESOURCE_LIMITS.operationMs,
    operation: "review",
    requestSignal: request.signal,
    requestId: context.requestId,
  });
  if (!admitted.ok) return aiExecutionResponse(admitted);

  let payload: unknown;
  try {
    payload = await parseBoundedJson(request, undefined, {
      deadlineMs: Math.max(
        0,
        RESOURCE_LIMITS.operationMs - (Date.now() - admitted.admission.startedAt),
      ),
      requestSignal: request.signal,
    });
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
  const execution = await executeAiOperation({
    admission: admitted.admission,
    claimAiRun,
    completeAiRunWithProposals: (scope, id, executionToken, outputText, proposals) =>
      completeAiRunWithProposals(
        scope,
        id,
        executionToken,
        outputText,
        proposals as Parameters<typeof completeAiRunWithProposals>[4],
      ),
    deadlineMs: RESOURCE_LIMITS.operationMs,
    execute: (prepared, provider, signal) => provider.generateReview({
      abortSignal: signal,
      messages: buildAiMessages({
        ...body,
        documentText: prepared.reviewedText,
        referencedDocuments: prepared.referencedDocuments,
        systemPrompt: prepared.template.systemPrompt,
      }),
    }),
    failAiRun,
    getAiRunByIdempotencyKey,
    idempotencyKey: idempotency.key,
    mapDurableResult: mapDurableReviewResult,
    mapFinalizedResult: (durable, review) =>
      mapReviewResponse(durable, review, review.findings.length - durable.proposals.length),
    operationFingerprint: () => createAiOperationFingerprint("review", {
      ...body,
      documentTextSource: hasSubmittedDocumentText ? "submitted" : "persisted",
    }),
    preflight: async () => {
      const prepared = await prepareAiCommandRequest(context, {
        deferProviderCreation: true,
        payload: body,
        useSubmittedDocumentText: hasSubmittedDocumentText,
      });
      return prepared.ok ? { ok: true as const, value: prepared } : prepared;
    },
    prepareFinalization: (review, prepared) => prepareReviewFinalization(review, prepared),
    requestSignal: request.signal,
    resolveProvider: async () => {
      const providerResult = await createAiProviderForCommand(context);
      return providerResult.ok
        ? {
            model: providerResult.provider.model,
            ok: true as const,
            provider: providerResult.provider,
            providerName: providerResult.provider.name,
          }
        : providerResult;
    },
    runInput: (prepared: PreparedAiCommandContext) => ({
      commandType: "document_review" as const,
      documentId: prepared.document.id,
      inputSummaryJson: {
        command: body.command,
        documentTextLength: prepared.reviewedText.length,
        referencedDocumentIds: prepared.referencedDocuments.map((reference) => reference.id),
        variableNames: Object.keys(body.variables),
      },
      promptTemplateId: prepared.template.id,
    }),
    scope: context,
  });

  return aiExecutionResponse(execution);
});

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}

function aiExecutionResponse<T>(execution: AiExecutionResult<T>) {
  if (execution.ok) return NextResponse.json(execution.value);
  if (execution.response) return execution.response;
  return NextResponse.json(
    {
      ...(execution.status === 409 && execution.code ? { code: execution.code } : {}),
      ...(execution.details ? { details: execution.details } : {}),
      error: execution.error,
    },
    { status: execution.status },
  );
}

function prepareReviewFinalization(review: ReviewResult, prepared: PreparedAiCommandContext) {
  const validFindings = review.findings
    .map((finding) => ({
      finding,
      occurrenceIndex: getUniqueOccurrenceIndex(prepared.reviewedText, finding.targetText),
    }))
    .filter(({ finding, occurrenceIndex }) =>
      occurrenceIndex !== null &&
      applyProposalToText(prepared.reviewedText, finding.targetText, finding.replacementText).ok,
    );
  return {
    outputText: JSON.stringify(review),
    proposals: validFindings.map(({ finding, occurrenceIndex }) => ({
      documentId: prepared.document.id,
      occurrenceIndex,
      targetText: finding.targetText,
      replacementText: finding.replacementText,
      explanation: formatFindingExplanation(finding),
    })),
  };
}

function mapDurableReviewResult(durable: DurableAiOperation) {
  if (typeof durable.run.outputText !== "string") throw new Error("Malformed durable review");
  let parsed: unknown;
  try {
    parsed = JSON.parse(durable.run.outputText);
  } catch {
    throw new Error("Malformed durable review");
  }
  const review = reviewResultSchema.parse(parsed);
  if (durable.proposals.length > review.findings.length) throw new Error("Malformed durable review");
  return mapReviewResponse(durable, review, review.findings.length - durable.proposals.length);
}

function mapReviewResponse(durable: DurableAiOperation, review: ReviewResult, skippedProposalCount: number) {
  return {
    proposals: durable.proposals.map(toSafeProposal),
    review,
    run: toPublicAiRun(durable.run, "document_review"),
    skippedProposalCount,
  };
}

function toSafeProposal(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Malformed durable AI proposal");
  const proposal = value as Partial<AiProposalRecord>;
  if (
    typeof proposal.id !== "string" ||
    typeof proposal.targetText !== "string" ||
    typeof proposal.replacementText !== "string" ||
    typeof proposal.explanation !== "string"
  ) {
    throw new Error("Malformed durable AI proposal");
  }
  return {
    appliedMode: proposal.appliedMode ?? null,
    command: proposal.command ?? null,
    defaultApplyMode: proposal.defaultApplyMode ?? "replace",
    explanation: proposal.explanation,
    id: proposal.id,
    occurrenceIndex: proposal.occurrenceIndex ?? null,
    replacementText: proposal.replacementText,
    source: proposal.source ?? "review",
    status: proposal.status ?? "pending",
    targetFrom: proposal.targetFrom ?? null,
    targetText: proposal.targetText,
    targetTo: proposal.targetTo ?? null,
  };
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
