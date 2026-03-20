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

import { twoFaCommand, handle2FACommand, handle2FAAutocomplete } from './twoFa.js';
import { resourceCommand, handleResourceCommand, handleResourceAutocomplete } from './resource.js';
import { guardianCommand, handleGuardianCommand, handleGuardianAutocomplete } from './guardian.js';
import { accessCommand, handleAccessCommand, handleAccessAutocomplete } from './access.js';
import { authCommand, handleAuthCommand } from './auth.js';
import { projectCommand, handleProjectCommand } from './project.js';
import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';

/**
 * All slash command definitions for registration.
 *
 * Each domain has its own clean top-level command:
 *   /2fa, /resource, /guardian, /access, /auth, /project
 */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  twoFaCommand.toJSON(),
  resourceCommand.toJSON(),
  guardianCommand.toJSON(),
  accessCommand.toJSON(),
  authCommand.toJSON(),
  projectCommand.toJSON(),
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
    case '2fa':
      await handle2FACommand(interaction, context);
      break;
    case 'resource':
      await handleResourceCommand(interaction, context);
      break;
    case 'guardian':
      await handleGuardianCommand(interaction, context);
      break;
    case 'access':
      await handleAccessCommand(interaction, context);
      break;
    case 'auth':
      await handleAuthCommand(interaction, context);
      break;
    case 'project':
      await handleProjectCommand(interaction, context);
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

  switch (commandName) {
    case '2fa':
      await handle2FAAutocomplete(interaction, context);
      break;
    case 'resource':
      await handleResourceAutocomplete(interaction, context);
      break;
    case 'guardian':
      await handleGuardianAutocomplete(interaction, context);
      break;
    case 'access':
      await handleAccessAutocomplete(interaction, context);
      break;
    // /auth and /project have no autocomplete
  }
}
