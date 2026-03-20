/**
 * Handler for /access command.
 *
 * Request and manage access to protected resources (request, approve, deny).
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';

import type { CommandContext } from './context.js';
import { handleRequestAccess } from './requestAccess.js';
import { handleDecisionCommand } from './decision.js';
import { handleResourceIdAutocomplete } from './resourceAutocomplete.js';

export const accessCommand = new SlashCommandBuilder()
  .setName('access')
  .setDescription('Request and manage access to protected resources')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('request')
      .setDescription('Request access to a protected resource')
      .addStringOption((option) =>
        option
          .setName('resource-id')
          .setDescription('ID of the resource to request access to')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('approve')
      .setDescription('Approve a pending access request')
      .addStringOption((option) =>
        option
          .setName('request-id')
          .setDescription('The ID of the request to approve')
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('deny')
      .setDescription('Deny a pending access request')
      .addStringOption((option) =>
        option
          .setName('request-id')
          .setDescription('The ID of the request to deny')
          .setRequired(true)
      )
  );

/**
 * Handle /access subcommands.
 */
export async function handleAccessCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'request':
      await handleRequestAccess(interaction, context);
      return;
    case 'approve':
      await handleDecisionCommand(interaction, context.services, 'APPROVE');
      return;
    case 'deny':
      await handleDecisionCommand(interaction, context.services, 'DENY');
      return;
    default:
      await interaction.reply({
        content: `Unknown subcommand: ${subcommand}`,
        ephemeral: true,
      });
  }
}

/**
 * Handle autocomplete for /access commands (resource-id on request).
 */
export async function handleAccessAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<void> {
  if (await handleResourceIdAutocomplete(interaction, context)) {
    return;
  }

  await interaction.respond([]);
}
