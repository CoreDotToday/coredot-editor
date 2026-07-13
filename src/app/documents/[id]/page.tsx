import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
import { listConversations } from "@/features/ai/conversation-repository";
import { resolveConversationStorageMode } from "@/features/ai/conversation-store";
import { getDocumentById, listDocumentReferenceCandidates } from "@/features/documents/document-repository";
import { listProposalsForDocument } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates } from "@/features/templates/template-repository";
import { getProtectedPageContext } from "@/features/auth/route-context";

type DocumentPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { id } = await params;
  const context = await getProtectedPageContext(`/documents/${id}`);
  const document = await getDocumentById(context, id);

  if (!document) {
    notFound();
  }

  const conversationStorageMode = resolveConversationStorageMode(process.env.CONVERSATION_STORAGE);
  const [templates, aiRuns, proposals, referenceDocuments, conversationResult] = await Promise.all([
    listActivePromptTemplates(context),
    listAiRunsForDocument(context, document.id),
    listProposalsForDocument(context, document.id),
    listDocumentReferenceCandidates(context, { excludeDocumentId: document.id, limit: 24 }),
    conversationStorageMode === "database"
      ? listConversations(context, { documentId: document.id }).catch(() => ({
          ok: false as const,
          reason: "unavailable" as const,
        }))
      : Promise.resolve(null),
  ]);

  return (
    <DocumentShell
      aiRuns={aiRuns.map((run) => ({
        commandType: run.commandType,
        createdAt: run.createdAt,
        id: run.id,
        status: run.status,
      }))}
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
      initialConversationLoadFailed={conversationResult !== null && !conversationResult.ok}
      initialConversations={conversationResult?.ok
        ? conversationResult.value.items.map((conversation) => ({ ...conversation, syncStatus: "saved" as const }))
        : undefined}
      proposals={proposals.map((proposal) => ({
        appliedMode: proposal.appliedMode,
        command: proposal.command,
        defaultApplyMode: proposal.defaultApplyMode,
        explanation: proposal.explanation,
        id: proposal.id,
        occurrenceIndex: proposal.occurrenceIndex,
        replacementText: proposal.replacementText,
        source: proposal.source,
        status: proposal.status,
        targetFrom: proposal.targetFrom,
        targetText: proposal.targetText,
        targetTo: proposal.targetTo,
      }))}
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
