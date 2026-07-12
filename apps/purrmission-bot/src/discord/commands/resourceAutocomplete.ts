import type { AutocompleteInteraction } from 'discord.js';

import type { CommandContext } from './context.js';
import { getGuardedResourcesForUser } from '../../domain/policy.js';

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

  const guardedResources = await getGuardedResourcesForUser(context.repositories, userId, query);

  if (guardedResources.length === 0) {
    await interaction.respond([]);
    return true;
  }

  const filteredResources = query
    ? guardedResources.filter((resource) => resource.name.toLowerCase().includes(query))
    : guardedResources;

  await interaction.respond(
    filteredResources.slice(0, MAX_AUTOCOMPLETE_RESULTS).map((resource) => ({
      name: resource.name,
      value: resource.id,
    }))
  );

  return true;
}
