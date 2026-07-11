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
      aiRuns={aiRuns}
      document={document}
      proposals={proposals}
      referenceDocuments={referenceDocuments}
      templates={templates}
    />
  );
}
