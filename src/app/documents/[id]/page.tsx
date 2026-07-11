import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
import { getDocumentById, listDocumentReferenceCandidates } from "@/features/documents/document-repository";
import { listProposalsForDocument } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates } from "@/features/templates/template-repository";

const localWorkspace = { workspaceId: "local" };

type DocumentPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { id } = await params;
  const document = await getDocumentById(localWorkspace, id);

  if (!document) {
    notFound();
  }

  const [templates, aiRuns, proposals, referenceDocuments] = await Promise.all([
    listActivePromptTemplates(localWorkspace),
    listAiRunsForDocument(localWorkspace, document.id),
    listProposalsForDocument(localWorkspace, document.id),
    listDocumentReferenceCandidates(localWorkspace, { excludeDocumentId: document.id, limit: 24 }),
  ]);

  return (
    <DocumentShell
      aiRuns={aiRuns}
      document={document}
      proposals={proposals}
      referenceDocuments={referenceDocuments}
      templates={templates}
    />
  );
}
