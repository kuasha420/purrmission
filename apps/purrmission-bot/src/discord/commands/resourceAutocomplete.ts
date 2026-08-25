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

  const assignments = await context.repositories.guardians.findByUserId(userId);
  if (assignments.length === 0) {
    await interaction.respond([]);
    return true;
  }

  const resourceIds = [...new Set(assignments.map((a) => a.resourceId))];
  const resources = await context.repositories.resources.findMetadataManyByIds(resourceIds);

  const filteredResources = query
    ? resources.filter(
        (resource) =>
          resource.name.toLowerCase().includes(query) || resource.id.toLowerCase().includes(query)
      )
    : resources;

  await interaction.respond(
    filteredResources.slice(0, MAX_AUTOCOMPLETE_RESULTS).map((resource) => ({
      name: resource.name,
      value: resource.id,
    }))
  );

  return true;
}
