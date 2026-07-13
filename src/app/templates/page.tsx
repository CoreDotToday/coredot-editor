import { PromptTemplateManager } from "@/components/templates/PromptTemplateManager";
import { listPromptTemplates } from "@/features/templates/template-repository";
import { getProtectedPageContext } from "@/features/auth/route-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const context = await getProtectedPageContext("/templates");
  const templates = await listPromptTemplates(context);
  return <PromptTemplateManager projectProfile={resolveActiveProjectProfile()} templates={templates} />;
}
