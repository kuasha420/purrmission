/**
 * Slash command definitions and routing.
 *
 * This module exports command definitions for registration and
 * provides a handler function for routing commands to their implementations.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

import { handleRegisterResource } from './registerResource.js';
import { handleAddGuardian } from './addGuardian.js';
import {
  handlePurrmissionCommand,
  purrmissionCommand,
  handlePurrmissionAutocomplete,
} from './twoFa.js';
import { logger } from '../../logging/logger.js';

/**
 * All slash command definitions for registration.
 */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('purrmission-register-resource')
    .setDescription('Register a new protected resource')
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Name of the resource to protect')
        .setRequired(true)
        .setMaxLength(100)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('purrmission-add-guardian')
    .setDescription('Add a guardian to a protected resource')
    .addStringOption((option) =>
      option.setName('resource-id').setDescription('ID of the resource').setRequired(true)
    )
    .addUserOption((option) =>
      option.setName('user').setDescription('User to add as guardian').setRequired(true)
    )
    .toJSON(),

  purrmissionCommand.toJSON(),
];

/**
 * Route slash commands to their handlers.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
import type { CommandContext } from './context.js';

/**
 * Route slash commands to their handlers.
 *
 * @param interaction - The command interaction
 * @param context - Command execution context with dependencies
 */
export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const { commandName } = interaction;
  const { services } = context;

  switch (commandName) {
    case 'purrmission-register-resource':
      await handleRegisterResource(interaction, services);
      break;

    case 'purrmission-add-guardian':
      await handleAddGuardian(interaction, services);
      break;

    case 'purrmission':
      await handlePurrmissionCommand(interaction, context);
      break;

    default:
      logger.warn('Unknown command received', { commandName });
      await interaction.reply({
        content: `Unknown command: ${commandName}`,
        ephemeral: true,
      });
  }
}

/**
 * Handle autocomplete interactions.
 *
 * @param interaction - The autocomplete interaction
 * @param context - Command execution context with dependencies
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  context: CommandContext
): Promise<void> {
  const { commandName } = interaction;

  if (commandName === 'purrmission') {
    await handlePurrmissionAutocomplete(interaction, context);
    return;
  }

  // No autocomplete for other commands yet – just exit.
}
