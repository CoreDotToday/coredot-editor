import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
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

  const [templates, aiRuns, proposals, referenceDocuments] = await Promise.all([
    listActivePromptTemplates(context),
    listAiRunsForDocument(context, document.id),
    listProposalsForDocument(context, document.id),
    listDocumentReferenceCandidates(context, { excludeDocumentId: document.id, limit: 24 }),
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
