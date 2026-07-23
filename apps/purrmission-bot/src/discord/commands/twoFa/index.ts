import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from '../context.js';
import { twoFaCommand } from './builder.js';
import { handleTwoFaAutocomplete, handle2FAAutocomplete } from './autocomplete.js';
import { handleAdd2FA } from './subcommands/add.js';
import { handleList2FA } from './subcommands/list.js';
import { handleGet2FA } from './subcommands/get.js';
import { handleUpdate2FA } from './subcommands/update.js';

/**
 * Main router function delegating execution to subcommand handlers.
 */
export async function handle2FACommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'add':
      await handleAdd2FA(interaction, context);
      return;
    case 'list':
      await handleList2FA(interaction, context);
      return;
    case 'get':
      await handleGet2FA(interaction, context);
      return;
    case 'update':
      await handleUpdate2FA(interaction, context);
      return;
    default:
      await interaction.reply({
        content: `Unknown subcommand: ${subcommand}`,
        ephemeral: true,
      });
  }
}

/**
 * Standard command object exports.
 */
export const data = twoFaCommand;
export const execute = handle2FACommand;
export const autocomplete = handleTwoFaAutocomplete;

/**
 * Named exports.
 */
export {
  twoFaCommand,
  handleTwoFaAutocomplete,
  handle2FAAutocomplete,
  handleAdd2FA,
  handleList2FA,
  handleGet2FA,
  handleUpdate2FA,
};
