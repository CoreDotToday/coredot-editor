import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
import { getDocumentById } from "@/features/documents/document-repository";
import { listProposalsForDocument } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates } from "@/features/templates/template-repository";

type DocumentPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { id } = await params;
  const document = await getDocumentById(id);

  if (!document) {
    notFound();
  }

  const [templates, aiRuns, proposals] = await Promise.all([
    listActivePromptTemplates(),
    listAiRunsForDocument(document.id),
    listProposalsForDocument(document.id),
  ]);

  return <DocumentShell aiRuns={aiRuns} document={document} proposals={proposals} templates={templates} />;
}
