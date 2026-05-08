import { notFound } from "next/navigation";
import { DocumentShell } from "@/components/document/DocumentShell";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
import { getDocumentById } from "@/features/documents/document-repository";
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

  const [templates, aiRuns] = await Promise.all([listActivePromptTemplates(), listAiRunsForDocument(document.id)]);

  return <DocumentShell aiRuns={aiRuns} document={document} templates={templates} />;
}
