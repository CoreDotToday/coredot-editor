import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptTemplates } from "@/db/schema";
import { defaultPromptTemplates, type DefaultPromptTemplate } from "@/db/seed";
import { createAiSettingsRepository } from "@/features/ai/ai-settings-repository";
import type { WorkspaceScope } from "@/features/auth/request-context";

type WorkspaceDatabase = typeof db;

function getWorkspaceDefaultTemplateId(scope: WorkspaceScope, templateId: string) {
  return `default-template:${templateId}:${encodeURIComponent(scope.workspaceId)}`;
}

export function createWorkspaceBootstrap(
  database: WorkspaceDatabase = db,
  builtins: readonly DefaultPromptTemplate[] = defaultPromptTemplates,
) {
  const aiSettingsRepository = createAiSettingsRepository(database);

  return async function ensureWorkspaceBootstrap(scope: WorkspaceScope) {
    const now = new Date();
    const existingDefaults = await database
      .select({ builtinKey: promptTemplates.builtinKey })
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.workspaceId, scope.workspaceId),
          eq(promptTemplates.isDefault, true),
        ),
      );
    const existingBuiltinKeys = new Set(
      existingDefaults.flatMap((template) => template.builtinKey ? [template.builtinKey] : []),
    );

    for (const template of builtins) {
      if (existingBuiltinKeys.has(template.id)) {
        continue;
      }

      await database
        .insert(promptTemplates)
        .values({
          id: getWorkspaceDefaultTemplateId(scope, template.id),
          workspaceId: scope.workspaceId,
          builtinKey: template.id,
          name: template.name,
          description: template.description,
          category: template.category,
          systemPrompt: template.systemPrompt,
          variableSchemaJson: template.variableSchema,
          isDefault: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [promptTemplates.workspaceId, promptTemplates.builtinKey] });
      existingBuiltinKeys.add(template.id);
    }

    await aiSettingsRepository.getAiSettings(scope);
  };
}

export const ensureWorkspaceBootstrap = createWorkspaceBootstrap();
