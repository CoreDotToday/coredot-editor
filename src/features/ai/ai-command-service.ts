import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { getDocumentById } from "@/features/documents/document-repository";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import { validateTemplateVariables } from "@/features/templates/template-validation";
import { getAiSettings, type AiSettings } from "./ai-settings-repository";
import { hydrateAiReferenceDocuments, type HydratedAiReferenceDocument } from "./reference-hydration";
import { createAiProvider, type AiProvider } from "./providers";
import type { AiCommandPayload } from "./types";

export type PreparedAiCommandRequest = {
  aiSettings: AiSettings;
  document: DocumentRecord;
  provider: AiProvider;
  referencedDocuments: HydratedAiReferenceDocument[];
  reviewedText: string;
  template: PromptTemplateRecord;
};

export type AiCommandRequestFailure = {
  details?: unknown;
  error: string;
  ok: false;
  status: 400 | 404 | 500;
};

export type AiCommandRequestResult =
  | ({ ok: true } & PreparedAiCommandRequest)
  | AiCommandRequestFailure;

export type PreparedAiCommandContext = Omit<PreparedAiCommandRequest, "aiSettings" | "provider">;

export type AiCommandContextResult =
  | ({ ok: true } & PreparedAiCommandContext)
  | AiCommandRequestFailure;

export type AiProviderCreationResult =
  | { aiSettings: AiSettings; ok: true; provider: AiProvider }
  | AiCommandRequestFailure;

export type AiCommandServiceDependencies = {
  createAiProvider: typeof createAiProvider;
  getAiSettings: typeof getAiSettings;
  getDocumentById: typeof getDocumentById;
  getPromptTemplateById: typeof getPromptTemplateById;
  hydrateAiReferenceDocuments: typeof hydrateAiReferenceDocuments;
};

const defaultDependencies: AiCommandServiceDependencies = {
  createAiProvider,
  getAiSettings,
  getDocumentById,
  getPromptTemplateById,
  hydrateAiReferenceDocuments,
};

export async function createAiProviderForCommand({
  dependencies = defaultDependencies,
}: {
  dependencies?: Pick<AiCommandServiceDependencies, "createAiProvider" | "getAiSettings">;
} = {}): Promise<AiProviderCreationResult> {
  try {
    const aiSettings = await dependencies.getAiSettings();
    return { aiSettings, ok: true, provider: dependencies.createAiProvider(aiSettings) };
  } catch {
    return { error: "AI generation failed", ok: false, status: 500 };
  }
}

export async function prepareAiCommandRequest({
  dependencies,
  deferProviderCreation,
  payload,
  useSubmittedDocumentText,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation: true;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandContextResult>;

export async function prepareAiCommandRequest({
  dependencies,
  deferProviderCreation,
  payload,
  useSubmittedDocumentText,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation?: false;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandRequestResult>;

export async function prepareAiCommandRequest({
  dependencies = defaultDependencies,
  deferProviderCreation = false,
  payload,
  useSubmittedDocumentText = false,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation?: boolean;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandRequestResult | AiCommandContextResult> {
  const document = await dependencies.getDocumentById(payload.documentId);
  if (!document) {
    return { error: "Document not found", ok: false, status: 404 };
  }

  const template = await dependencies.getPromptTemplateById(payload.templateId);
  if (!template?.isActive) {
    return { error: "Template not found", ok: false, status: 404 };
  }

  const variableValidation = validateTemplateVariables(template.variableSchemaJson, payload.variables);
  if (!variableValidation.ok) {
    return {
      details: variableValidation.errors,
      error: "Invalid template variables",
      ok: false,
      status: 400,
    };
  }

  const referencedDocuments = await dependencies.hydrateAiReferenceDocuments(payload.references, {
    currentDocumentId: document.id,
  });

  const preparedContext = {
    document,
    ok: true,
    referencedDocuments,
    reviewedText: useSubmittedDocumentText ? payload.documentText : document.plainText,
    template,
  } satisfies { ok: true } & PreparedAiCommandContext;

  if (deferProviderCreation) {
    return preparedContext;
  }

  const providerResult = await createAiProviderForCommand({ dependencies });
  if (!providerResult.ok) {
    return providerResult;
  }

  return {
    ...preparedContext,
    aiSettings: providerResult.aiSettings,
    provider: providerResult.provider,
  };
}
