import { NextResponse } from "next/server";
import { aiCommandPayloadSchema, type ReviewResult } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import { completeAiRun, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById } from "@/features/documents/document-repository";
import { createProposal } from "@/features/proposals/proposal-repository";
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

  const provider = createAiProvider();
  const run = await createAiRun({
    documentId: document.id,
    promptTemplateId: template.id,
    commandType: "document_review",
    provider: provider.name,
    model: provider.model,
    inputSummaryJson: {
      command: body.command,
      documentTextLength: (body.documentText || document.plainText).length,
      variableNames: Object.keys(body.variables),
    },
  });

  try {
    const messages = buildAiMessages({
      ...body,
      documentText: body.documentText || document.plainText,
      systemPrompt: template.systemPrompt,
    });
    const review = await provider.generateReview({ messages });
    const proposals = await Promise.all(
      review.findings.map((finding) =>
        createProposal({
          aiRunId: run.id,
          documentId: document.id,
          targetText: finding.targetText,
          replacementText: finding.replacementText,
          explanation: formatFindingExplanation(finding),
        }),
      ),
    );
    const completedRun = await completeAiRun(run.id, JSON.stringify(review));

    return NextResponse.json({ run: completedRun ?? run, review, proposals });
  } catch (error) {
    await failAiRun(run.id, error instanceof Error ? error.message : "Unknown AI generation failure");
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}

function formatFindingExplanation(finding: ReviewResult["findings"][number]): string {
  return `${finding.problem}: ${finding.reason}`;
}
