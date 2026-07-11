import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptTemplates } from "@/db/schema";
import { defaultPromptTemplates } from "@/db/seed";
import { createAiSettingsRepository } from "@/features/ai/ai-settings-repository";
import type { WorkspaceScope } from "@/features/auth/request-context";

type WorkspaceDatabase = typeof db;

function getWorkspaceDefaultTemplateId(scope: WorkspaceScope, templateId: string) {
  return `default-template:${templateId}:${encodeURIComponent(scope.workspaceId)}`;
}

export function createWorkspaceBootstrap(database: WorkspaceDatabase = db) {
  const aiSettingsRepository = createAiSettingsRepository(database);

  return async function ensureWorkspaceBootstrap(scope: WorkspaceScope) {
    const now = new Date();
    const existingDefaults = await database
      .select({ category: promptTemplates.category })
      .from(promptTemplates)
      .where(and(eq(promptTemplates.workspaceId, scope.workspaceId), eq(promptTemplates.isDefault, true)));
    const existingDefaultCategories = new Set(existingDefaults.map((template) => template.category));

    for (const template of defaultPromptTemplates) {
      if (existingDefaultCategories.has(template.category)) {
        continue;
      }

      await database
        .insert(promptTemplates)
        .values({
          id: getWorkspaceDefaultTemplateId(scope, template.id),
          workspaceId: scope.workspaceId,
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
        .onConflictDoNothing({ target: promptTemplates.id });
      existingDefaultCategories.add(template.category);
    }

    await aiSettingsRepository.getAiSettings(scope);
  };
}

export const ensureWorkspaceBootstrap = createWorkspaceBootstrap();
