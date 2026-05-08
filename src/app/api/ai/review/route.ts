import { NextResponse } from "next/server";
import { aiCommandPayloadSchema, type ReviewResult } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import { completeAiRunWithProposals, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById } from "@/features/documents/document-repository";
import { applyProposalToText } from "@/features/proposals/proposal-apply";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import { validateTemplateVariables } from "@/features/templates/template-validation";

export async function POST(request: Request) {
  const result = aiCommandPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  const document = await getDocumentById(body.documentId);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const template = await getPromptTemplateById(body.templateId);
  if (!template?.isActive) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const variableValidation = validateTemplateVariables(template.variableSchemaJson, body.variables);
  if (!variableValidation.ok) {
    return NextResponse.json(
      { error: "Invalid template variables", details: variableValidation.errors },
      { status: 400 },
    );
  }

  let provider;
  try {
    provider = createAiProvider();
  } catch {
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }

  const reviewedText = body.documentText || document.plainText;

  const run = await createAiRun({
    documentId: document.id,
    promptTemplateId: template.id,
    commandType: "document_review",
    provider: provider.name,
    model: provider.model,
    inputSummaryJson: {
      command: body.command,
      documentTextLength: reviewedText.length,
      variableNames: Object.keys(body.variables),
    },
  });

  try {
    const messages = buildAiMessages({
      ...body,
      documentText: reviewedText,
      systemPrompt: template.systemPrompt,
    });
    const review = await provider.generateReview({ messages });
    const validFindings = review.findings.filter((finding) =>
      applyProposalToText(reviewedText, finding.targetText, finding.replacementText).ok,
    );
    const skippedProposalCount = review.findings.length - validFindings.length;

    if (review.findings.length > 0 && validFindings.length === 0) {
      throw new Error("AI review produced no applicable findings");
    }

    const outputText = JSON.stringify(review);
    const finalizedRun = await completeAiRunWithProposals(
      run.id,
      outputText,
      validFindings.map((finding) => ({
        documentId: document.id,
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
    await failAiRun(run.id, error instanceof Error ? error.message : "Unknown AI generation failure");
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}

function formatFindingExplanation(finding: ReviewResult["findings"][number]): string {
  return `${finding.problem}: ${finding.reason}`;
}
