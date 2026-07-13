import { NextResponse } from "next/server";
import { z } from "zod";
import type { AiProposalRecord } from "@/db/schema";
import { aiCommandPayloadSchema } from "@/features/ai/types";
import { AI_CONTEXT_LIMITS } from "@/features/ai/context-limits";
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
import { validateProposalTargetOccurrence } from "@/features/proposals/proposal-apply";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  RESOURCE_LIMITS,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
} from "@/features/security/resource-policy";

const rewritePayloadSchema = aiCommandPayloadSchema.extend({
  selectedText: z
    .string()
    .max(AI_CONTEXT_LIMITS.selectedTextMaxCharacters)
    .refine((value) => value.trim().length > 0),
});
const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();

  const idempotency = resolveAiIdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return NextResponse.json({ error: idempotency.error }, { status: idempotency.status });
  }
  const admitted = await admitAiOperation({
    admitRequest: () => enforceRequestBudget(context, "ai.rewrite"),
    deadlineMs: RESOURCE_LIMITS.operationMs,
    operation: "rewrite",
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
  const result = rewritePayloadSchema.safeParse(payload);
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
    execute: async (prepared, provider, signal) => normalizeSelectionRewriteResult(
      await provider.generateText({
        abortSignal: signal,
        messages: buildAiMessages({
          ...body,
          documentText: prepared.reviewedText,
          referencedDocuments: prepared.referencedDocuments,
          systemPrompt: buildSelectionRewriteSystemPrompt(prepared.template.systemPrompt, body.command),
        }),
      }),
    ),
    failAiRun,
    getAiRunByIdempotencyKey,
    idempotencyKey: idempotency.key,
    mapDurableResult: mapDurableRewriteResult,
    mapFinalizedResult: (durable) => mapRewriteResponse(durable),
    operationFingerprint: () => createAiOperationFingerprint("rewrite", {
      ...body,
      documentTextSource: hasSubmittedDocumentText ? "submitted" : "persisted",
    }),
    preflight: async () => {
      const prepared = await prepareAiCommandRequest(context, {
        deferProviderCreation: true,
        payload: body,
        useSubmittedDocumentText: hasSubmittedDocumentText,
      });
      if (!prepared.ok) return prepared;

      const targetValidation = validateProposalTargetOccurrence(
        prepared.reviewedText,
        body.selectedText,
        body.occurrenceIndex,
      );
      if (!targetValidation.ok && body.occurrenceIndex !== undefined) {
        return {
          error: "Selected text occurrence was not found in the document",
          ok: false as const,
          status: 400 as const,
        };
      }
      if (!targetValidation.ok) {
        return {
          error: "Selected text must match exactly once in the document",
          ok: false as const,
          status: 400 as const,
        };
      }
      return { ok: true as const, value: prepared };
    },
    prepareFinalization: (rewriteResult, prepared) => ({
      outputText: rewriteResult.replacementText,
      proposals: [{
        command: body.command,
        defaultApplyMode: body.defaultApplyMode ?? getDefaultApplyModeForCommand(body.command),
        documentId: prepared.document.id,
        occurrenceIndex: body.occurrenceIndex,
        source: "selection" as const,
        targetText: body.selectedText,
        targetFrom: body.selectionRange?.from,
        targetTo: body.selectionRange?.to,
        replacementText: rewriteResult.replacementText,
        explanation: rewriteResult.explanation,
      }],
    }),
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
      commandType: "selection_rewrite" as const,
      documentId: prepared.document.id,
      inputSummaryJson: {
        afterContextLength: body.afterContext.length,
        command: body.command,
        documentTextLength: prepared.reviewedText.length,
        beforeContextLength: body.beforeContext.length,
        occurrenceIndex: body.occurrenceIndex,
        referencedDocumentIds: prepared.referencedDocuments.map((reference) => reference.id),
        selectedTextLength: body.selectedText.length,
        selectionRange: body.selectionRange,
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

function mapDurableRewriteResult(durable: DurableAiOperation) {
  if (typeof durable.run.outputText !== "string" || durable.proposals.length !== 1) {
    throw new Error("Malformed durable rewrite");
  }
  const proposal = toSafeProposal(durable.proposals[0]);
  if (proposal.source !== "selection" || proposal.replacementText !== durable.run.outputText) {
    throw new Error("Malformed durable rewrite");
  }
  return {
    proposal,
    run: toPublicAiRun(durable.run, "selection_rewrite"),
  };
}

function mapRewriteResponse(durable: DurableAiOperation) {
  if (durable.proposals.length !== 1) throw new Error("Malformed finalized rewrite");
  return {
    proposal: toSafeProposal(durable.proposals[0]),
    run: toPublicAiRun(durable.run, "selection_rewrite"),
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
    source: proposal.source ?? "selection",
    status: proposal.status ?? "pending",
    targetFrom: proposal.targetFrom ?? null,
    targetText: proposal.targetText,
    targetTo: proposal.targetTo ?? null,
  };
}

function getDefaultApplyModeForCommand(command: string) {
  const normalizedCommand = command.toLowerCase();
  return normalizedCommand.includes("translate") ||
    normalizedCommand.includes("continue writing") ||
    normalizedCommand.includes("summarize") ||
    normalizedCommand.includes("outline") ||
    normalizedCommand.includes("key risks")
    ? "insert_below"
    : "replace";
}

function buildSelectionRewriteSystemPrompt(templateSystemPrompt: string, command: string) {
  const commandModeRules = command.toLowerCase().includes("continue writing")
    ? [
        "## Continue writing mode",
        "Write only new continuation text that should follow the selected text.",
        "Do not repeat the selected text.",
        "Continue the same document voice, structure, factual constraints, and level of specificity.",
      ].join("\n")
    : "";

  return [
    [
      "## Selection rewrite mode",
      "You are editing selected document text for this request.",
      "Return only a compact JSON object with this shape: {\"replacementText\":\"...\",\"explanation\":\"...\"}.",
      "Use replacementText for the exact text that should be proposed in the document.",
      "Use explanation for one short sentence explaining why the edit helps.",
      "Do not return markdown fences, labels, findings, summary, or acceptance instructions.",
      "Use the selected prompt template below only for domain context, terminology, risk criteria, and tone.",
      "Any template instruction that asks for a review schema, findings, summary, or structured API output is superseded for this selection rewrite request.",
    ].join("\n"),
    commandModeRules,
    ["## Selected prompt template context", templateSystemPrompt].join("\n"),
  ].filter(Boolean).join("\n\n");
}

function normalizeSelectionRewriteResult(rawText: string) {
  const parsed = parsePossibleJsonObject(stripJsonFence(rawText.trim()));
  const structuredResult = getStructuredRewriteResult(parsed);

  return structuredResult ?? {
    explanation: "AI rewrite suggestion.",
    replacementText: rawText,
  };
}

function stripJsonFence(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function parsePossibleJsonObject(text: string): unknown {
  if (!text.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getStructuredRewriteResult(value: unknown): { explanation: string; replacementText: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if ("replacementText" in value && typeof value.replacementText === "string") {
    return {
      explanation:
        "explanation" in value && typeof value.explanation === "string" && value.explanation.trim()
          ? value.explanation
          : "AI rewrite suggestion.",
      replacementText: value.replacementText,
    };
  }

  if (!("findings" in value) || !Array.isArray(value.findings)) {
    return null;
  }

  const finding = value.findings.find(
    (item): item is { problem?: string; reason?: string; replacementText: string } =>
      Boolean(item) && typeof item === "object" && "replacementText" in item && typeof item.replacementText === "string",
  );

  if (!finding) {
    return null;
  }

  return {
    explanation: finding.reason?.trim() || finding.problem?.trim() || "AI rewrite suggestion.",
    replacementText: finding.replacementText,
  };
}
