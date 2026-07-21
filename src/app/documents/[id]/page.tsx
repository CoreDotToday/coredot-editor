import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunSummariesPage } from "@/features/ai/ai-run-repository";
import { listConversations } from "@/features/ai/conversation-repository";
import { resolveConversationStorageMode } from "@/features/ai/conversation-store";
import { getDocumentById, listDocumentReferenceCandidates } from "@/features/documents/document-repository";
import { listProposalSummariesPage } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates } from "@/features/templates/template-repository";
import { getProtectedPageContext } from "@/features/auth/route-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import { resolveCollaborationClientConfiguration } from "@/features/collaboration/client-configuration";

type DocumentPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { id } = await params;
  const context = await getProtectedPageContext(`/documents/${id}`);
  const projectProfile = resolveActiveProjectProfile();
  const document = await getDocumentById(context, id);

  if (!document) {
    notFound();
  }

  const conversationStorageMode = resolveConversationStorageMode(process.env.CONVERSATION_STORAGE);
  const [
    templates,
    aiRunPage,
    proposalPage,
    referenceDocuments,
    conversationResult,
    collaboration,
  ] = await Promise.all([
    listActivePromptTemplates(context),
    listAiRunSummariesPage(context, document.id, { limit: 20 }),
    listProposalSummariesPage(context, document.id, { limit: 20 }),
    listDocumentReferenceCandidates(context, { excludeDocumentId: document.id, limit: 24 }),
    conversationStorageMode === "database"
      ? listConversations(context, { documentId: document.id }).catch(() => ({
          ok: false as const,
          reason: "unavailable" as const,
        }))
      : Promise.resolve(null),
    resolveCollaborationClientConfiguration(context, document.id),
  ]);
  const defaultTemplateId = projectProfile.defaultTemplateIds
    .map((builtinKey) => templates.find((template) => template.builtinKey === builtinKey)?.id)
    .find((templateId): templateId is string => Boolean(templateId));

  return (
    <DocumentShell
      aiRuns={aiRunPage.items.map((run) => ({
        commandType: run.commandType,
        createdAt: run.createdAt,
        id: run.id,
        status: run.status,
      }))}
      aiRunsNextCursor={aiRunPage.nextCursor}
      collaboration={collaboration}
      document={{
        id: document.id,
        title: document.title,
        contentJson: document.contentJson,
        plainText: document.plainText,
        revision: document.revision,
        metadataJson: document.metadataJson,
        readiness: document.readiness,
      }}
      conversationStorageMode={conversationStorageMode}
      conversationWorkspaceId={context.workspaceId}
      defaultTemplateId={defaultTemplateId}
      initialConversationLoadFailed={conversationResult !== null && !conversationResult.ok}
      initialConversationNextCursor={conversationResult?.ok ? conversationResult.value.nextCursor : null}
      initialConversations={conversationResult?.ok
        ? conversationResult.value.items.map((conversation) => ({ ...conversation, syncStatus: "saved" as const }))
        : undefined}
      proposals={proposalPage.items.map((proposal) => ({
        appliedMode: proposal.appliedMode,
        command: proposal.command,
        defaultApplyMode: proposal.defaultApplyMode,
        explanation: proposal.explanation,
        id: proposal.id,
        isTruncated: Boolean(proposal.isTruncated),
        occurrenceIndex: proposal.occurrenceIndex,
        replacementText: proposal.replacementText,
        source: proposal.source,
        status: proposal.status,
        targetFrom: proposal.targetFrom,
        targetText: proposal.targetText,
        targetTo: proposal.targetTo,
      }))}
      proposalsNextCursor={proposalPage.nextCursor}
      projectProfile={projectProfile}
      referenceDocuments={referenceDocuments.map((referenceDocument) => ({
        id: referenceDocument.id,
        title: referenceDocument.title,
        plainText: referenceDocument.plainText,
        updatedAt: referenceDocument.updatedAt,
      }))}
      templates={templates.map((template) => ({
        category: template.category,
        id: template.id,
        name: template.name,
        variableSchemaJson: template.variableSchemaJson,
      }))}
    />
  );
}
