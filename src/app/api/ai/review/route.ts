import { NextResponse } from "next/server";
import { aiCommandPayloadSchema, type ReviewResult } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import { completeAiRunWithProposals, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { hydrateAiReferenceDocuments } from "@/features/ai/reference-hydration";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById } from "@/features/documents/document-repository";
import { applyProposalToText } from "@/features/proposals/proposal-apply";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import { validateTemplateVariables } from "@/features/templates/template-validation";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const result = aiCommandPayloadSchema.safeParse(payload);
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
    const aiSettings = await getAiSettings();
    provider = createAiProvider(aiSettings);
  } catch {
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }

  const hasSubmittedDocumentText =
    typeof payload === "object" && payload !== null && Object.hasOwn(payload, "documentText");
  const reviewedText = hasSubmittedDocumentText ? body.documentText : document.plainText;
  const referencedDocuments = await hydrateAiReferenceDocuments(body.references);

  const run = await createAiRun({
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
    const review = await provider.generateReview({ messages });
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
    await failAiRun(run.id, error instanceof Error ? error.message : "Unknown AI generation failure");
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
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
