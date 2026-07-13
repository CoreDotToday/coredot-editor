import type { EditorLanguage, EditorMessages } from "@/features/i18n/editor-language";
import {
  createEmptyEditorPluginContributions,
  type EditorPlugin,
  type EditorPluginContext,
  type EditorPluginContributions,
} from "./types";

type EditorPluginRegistryOptions = {
  disabledPluginIds?: string[];
  featureFlags?: Record<string, boolean>;
};

type ResolvePluginContributionsInput = {
  language: EditorLanguage;
  messages: EditorMessages;
};

export function createEditorPluginRegistry(plugins: EditorPlugin[], options: EditorPluginRegistryOptions = {}) {
  const disabledPluginIds = new Set(options.disabledPluginIds ?? []);
  const enabledPlugins = plugins.filter((plugin) => !disabledPluginIds.has(plugin.id));
  const sortedPlugins = sortPluginsByDependency(enabledPlugins);
  const enabledPluginIds = sortedPlugins.map((plugin) => plugin.id);
  const featureFlags = options.featureFlags ?? {};

  return {
    plugins: sortedPlugins,
    resolve(input: ResolvePluginContributionsInput) {
      return resolvePluginContributions(sortedPlugins, {
        enabledPluginIds,
        featureFlags,
        language: input.language,
        messages: input.messages,
      });
    },
  };
}

export function mergeEditorPluginContributions(
  base: EditorPluginContributions,
  additional?: Partial<EditorPluginContributions>,
): EditorPluginContributions {
  if (!additional) return base;

  const merged = {
    blockActions: [...base.blockActions, ...(additional.blockActions ?? [])],
    selectionCommands: [...base.selectionCommands, ...(additional.selectionCommands ?? [])],
    settingsSections: [...base.settingsSections, ...(additional.settingsSections ?? [])],
    slashCommands: [...base.slashCommands, ...(additional.slashCommands ?? [])],
    tiptapExtensions: [...base.tiptapExtensions, ...(additional.tiptapExtensions ?? [])],
    toolbarItems: [...base.toolbarItems, ...(additional.toolbarItems ?? [])],
    workspacePanels: [...base.workspacePanels, ...(additional.workspacePanels ?? [])],
  };

  assertUniqueEditorContributionIds(merged);
  return merged;
}

function resolvePluginContributions(plugins: EditorPlugin[], context: EditorPluginContext) {
  const contributions = createEmptyEditorPluginContributions();

  plugins.forEach((plugin) => {
    contributions.tiptapExtensions.push(
      ...resolvePluginFactory(plugin, "tiptapExtensions", plugin.tiptapExtensions, context),
    );
    contributions.selectionCommands.push(
      ...resolvePluginFactory(plugin, "selectionCommands", plugin.selectionCommands, context),
    );
    contributions.slashCommands.push(...resolvePluginFactory(plugin, "slashCommands", plugin.slashCommands, context));
    contributions.toolbarItems.push(...resolvePluginFactory(plugin, "toolbarItems", plugin.toolbarItems, context));
    contributions.blockActions.push(...resolvePluginFactory(plugin, "blockActions", plugin.blockActions, context));
    contributions.workspacePanels.push(
      ...resolvePluginFactory(plugin, "workspacePanels", plugin.workspacePanels, context),
    );
    contributions.settingsSections.push(
      ...resolvePluginFactory(plugin, "settingsSections", plugin.settingsSections, context),
    );
  });

  assertUniqueEditorContributionIds(contributions);

  return contributions;
}

function resolvePluginFactory<Result>(
  plugin: EditorPlugin,
  key: string,
  factory: ((context: EditorPluginContext) => Result[]) | undefined,
  context: EditorPluginContext,
) {
  if (!factory) {
    return [];
  }

  try {
    return factory(context);
  } catch {
    console.error("Editor plugin contribution factory failed.", {
      contributionType: key,
      pluginId: plugin.id,
    });
    return [];
  }
}

function sortPluginsByDependency(plugins: EditorPlugin[]) {
  const pluginById = new Map<string, EditorPlugin>();

  plugins.forEach((plugin) => {
    if (pluginById.has(plugin.id)) {
      throw new Error(`Duplicate editor plugin id: ${plugin.id}`);
    }
    pluginById.set(plugin.id, plugin);
  });

  plugins.forEach((plugin) => {
    (plugin.dependencies ?? []).forEach((dependencyId) => {
      if (!pluginById.has(dependencyId)) {
        throw new Error(`Editor plugin "${plugin.id}" depends on missing plugin: ${dependencyId}`);
      }
    });
  });

  const sorted: EditorPlugin[] = [];
  const permanentMarks = new Set<string>();
  const temporaryMarks = new Set<string>();

  const visit = (plugin: EditorPlugin, stack: string[]) => {
    if (permanentMarks.has(plugin.id)) return;
    if (temporaryMarks.has(plugin.id)) {
      throw new Error(`Cyclic editor plugin dependency: ${[...stack, plugin.id].join(" -> ")}`);
    }

    temporaryMarks.add(plugin.id);
    (plugin.dependencies ?? []).forEach((dependencyId) => {
      const dependency = pluginById.get(dependencyId);
      if (dependency) {
        visit(dependency, [...stack, plugin.id]);
      }
    });
    temporaryMarks.delete(plugin.id);
    permanentMarks.add(plugin.id);
    sorted.push(plugin);
  };

  plugins.forEach((plugin) => visit(plugin, []));

  return sorted;
}

function assertUniqueContributionIds(contributionType: string, contributions: Array<{ id: string }>) {
  const seenIds = new Set<string>();

  contributions.forEach((contribution) => {
    if (seenIds.has(contribution.id)) {
      throw new Error(`Duplicate editor plugin contribution id in ${contributionType}: ${contribution.id}`);
    }

    seenIds.add(contribution.id);
  });
}

function assertUniqueEditorContributionIds(contributions: EditorPluginContributions) {
  assertUniqueContributionIds("selectionCommands", contributions.selectionCommands);
  assertUniqueContributionIds("slashCommands", contributions.slashCommands);
  assertUniqueContributionIds("toolbarItems", contributions.toolbarItems);
  assertUniqueContributionIds("blockActions", contributions.blockActions);
  assertUniqueContributionIds("workspacePanels", contributions.workspacePanels);
  assertUniqueContributionIds("settingsSections", contributions.settingsSections);
}
