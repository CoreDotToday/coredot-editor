import { PromptTemplateManager } from "@/components/templates/PromptTemplateManager";
import { listPromptTemplates } from "@/features/templates/template-repository";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const templates = await listPromptTemplates();
  return <PromptTemplateManager templates={templates} />;
}
