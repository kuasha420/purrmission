/**
 * Slash command definitions and routing.
 *
 * This module exports command definitions for registration and
 * provides a handler function for routing commands to their implementations.
 */

import {
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

import {
  handlePurrmissionCommand,
  purrmissionCommand,
  handlePurrmissionAutocomplete,
} from './twoFa.js';
import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';

/**
 * All slash command definitions for registration.
 *
 * Only the /purrmission command remains — all subcommands
 * (resource, 2fa, guardian, access, auth, project) live under it.
 */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  purrmissionCommand.toJSON(),
];

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

  switch (commandName) {
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
