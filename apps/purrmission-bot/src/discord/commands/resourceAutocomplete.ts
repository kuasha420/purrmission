import type { AutocompleteInteraction } from 'discord.js';

import type { CommandContext } from './context.js';

const MAX_AUTOCOMPLETE_RESULTS = 25;

export async function handleResourceIdAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<boolean> {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name !== 'resource-id') {
    return false;
  }

  const query = String(focusedOption.value).trim().toLowerCase();
  const userId = interaction.user.id;
  const { guardians, resources } = context.repositories;

  const resourceIds = [...new Set((await guardians.findByUserId(userId)).map((g) => g.resourceId))];

  if (resourceIds.length === 0) {
    await interaction.respond([]);
    return true;
  }

  const matchedResources = await resources.findManyByIds(resourceIds, query);
  const filteredResources = query
    ? matchedResources.filter((resource) => resource.name.toLowerCase().includes(query))
    : matchedResources;

  await interaction.respond(
    filteredResources.slice(0, MAX_AUTOCOMPLETE_RESULTS).map((resource) => ({
      name: resource.name,
      value: resource.id,
    }))
  );

  return true;
}
