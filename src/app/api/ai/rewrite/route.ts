import { NextResponse } from "next/server";
import { z } from "zod";
import { aiCommandPayloadSchema } from "@/features/ai/types";
import { buildAiMessages } from "@/features/ai/payload-builder";
import { completeAiRunWithProposals, createAiRun, failAiRun } from "@/features/ai/ai-run-repository";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import { getDocumentById } from "@/features/documents/document-repository";
import { validateProposalTargetOccurrence } from "@/features/proposals/proposal-apply";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import { validateTemplateVariables } from "@/features/templates/template-validation";

const rewritePayloadSchema = aiCommandPayloadSchema.extend({
  selectedText: z.string().refine((value) => value.trim().length > 0),
});

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const result = rewritePayloadSchema.safeParse(payload);
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

  const hasSubmittedDocumentText =
    typeof payload === "object" && payload !== null && Object.hasOwn(payload, "documentText");
  const reviewedText = hasSubmittedDocumentText ? body.documentText : document.plainText;
  const targetValidation = validateProposalTargetOccurrence(reviewedText, body.selectedText, body.occurrenceIndex);
  if (!targetValidation.ok && body.occurrenceIndex !== undefined) {
    return NextResponse.json({ error: "Selected text occurrence was not found in the document" }, { status: 400 });
  }

  if (!targetValidation.ok) {
    return NextResponse.json({ error: "Selected text must match exactly once in the document" }, { status: 400 });
  }

  let provider;
  try {
    const aiSettings = await getAiSettings();
    provider = createAiProvider(aiSettings);
  } catch {
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }

  const run = await createAiRun({
    documentId: document.id,
    promptTemplateId: template.id,
    commandType: "selection_rewrite",
    provider: provider.name,
    model: provider.model,
    inputSummaryJson: {
      command: body.command,
      occurrenceIndex: body.occurrenceIndex,
      selectedTextLength: body.selectedText.length,
      selectionRange: body.selectionRange,
      variableNames: Object.keys(body.variables),
    },
  });

  try {
    const messages = buildAiMessages({
      ...body,
      documentText: reviewedText,
      systemPrompt: buildSelectionRewriteSystemPrompt(template.systemPrompt, body.command),
    });
    const replacementText = normalizeSelectionRewriteText(await provider.generateText({ messages }));
    const finalizedRun = await completeAiRunWithProposals(run.id, replacementText, [
      {
        command: body.command,
        defaultApplyMode: getDefaultApplyModeForCommand(body.command),
        documentId: document.id,
        occurrenceIndex: body.occurrenceIndex,
        source: "selection",
        targetText: body.selectedText,
        targetFrom: body.selectionRange?.from,
        targetTo: body.selectionRange?.to,
        replacementText,
        explanation: "AI rewrite suggestion.",
      },
    ]);

    return NextResponse.json({ run: finalizedRun?.run ?? run, proposal: finalizedRun?.proposals[0] ?? null });
  } catch (error) {
    await failAiRun(run.id, error instanceof Error ? error.message : "Unknown AI generation failure");
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}

function getDefaultApplyModeForCommand(command: string) {
  const normalizedCommand = command.toLowerCase();
  return normalizedCommand.includes("translate") || normalizedCommand.includes("continue writing")
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
      "Return only the replacement text for the selected text.",
      "Do not return JSON, findings, summary, markdown fences, labels, explanations, or acceptance instructions.",
      "Use the selected prompt template below only for domain context, terminology, risk criteria, and tone.",
      "Any template instruction that asks for a review schema, findings, summary, or structured API output is superseded for this selection rewrite request.",
    ].join("\n"),
    commandModeRules,
    ["## Selected prompt template context", templateSystemPrompt].join("\n"),
  ].filter(Boolean).join("\n\n");
}

function normalizeSelectionRewriteText(rawText: string) {
  const parsed = parsePossibleJsonObject(stripJsonFence(rawText.trim()));
  const replacementText = getStructuredReplacementText(parsed);

  return replacementText ?? rawText;
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

function getStructuredReplacementText(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if ("replacementText" in value && typeof value.replacementText === "string") {
    return value.replacementText;
  }

  if (!("findings" in value) || !Array.isArray(value.findings)) {
    return null;
  }

  const finding = value.findings.find(
    (item): item is { replacementText: string } =>
      Boolean(item) && typeof item === "object" && "replacementText" in item && typeof item.replacementText === "string",
  );

  return finding?.replacementText ?? null;
}
