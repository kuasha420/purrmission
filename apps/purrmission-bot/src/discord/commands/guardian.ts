/**
 * Handler for /guardian command.
 *
 * Manages guardians (add, remove, list) for protected resources.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';

import type { CommandContext } from './context.js';
import { handleAddGuardian } from './addGuardian.js';
import { handleRemoveGuardian } from './removeGuardian.js';
import { handleListGuardians } from './listGuardians.js';
import { handleResourceIdAutocomplete } from './resourceAutocomplete.js';

export const guardianCommand = new SlashCommandBuilder()
  .setName('guardian')
  .setDescription('Manage guardians for protected resources')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a guardian to a protected resource')
      .addStringOption((option) =>
        option
          .setName('resource-id')
          .setDescription('ID of the resource')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addUserOption((option) =>
        option.setName('user').setDescription('User to add as guardian').setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a guardian from a protected resource')
      .addStringOption((option) =>
        option
          .setName('resource-id')
          .setDescription('ID of the resource')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addUserOption((option) =>
        option.setName('user').setDescription('User to remove').setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List all guardians for a resource')
      .addStringOption((option) =>
        option
          .setName('resource-id')
          .setDescription('ID of the resource')
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

/**
 * Handle /guardian subcommands.
 */
export async function handleGuardianCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'add':
      await handleAddGuardian(interaction, context.services);
      return;
    case 'remove':
      await handleRemoveGuardian(interaction, context.services);
      return;
    case 'list':
      await handleListGuardians(interaction, context.services);
      return;
    default:
      await interaction.reply({
        content: `Unknown subcommand: ${subcommand}`,
        ephemeral: true,
      });
  }
}

/**
 * Handle autocomplete for /guardian commands (resource-id).
 */
export async function handleGuardianAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<void> {
  if (await handleResourceIdAutocomplete(interaction, context)) {
    return;
  }

  await interaction.respond([]);
}
