import { PromptTemplateManager } from "@/components/templates/PromptTemplateManager";
import { listPromptTemplates } from "@/features/templates/template-repository";

const localWorkspace = { workspaceId: "local" };

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const templates = await listPromptTemplates(localWorkspace);
  return <PromptTemplateManager templates={templates} />;
}
