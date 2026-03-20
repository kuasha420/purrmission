/**
 * Handler for /auth command.
 *
 * Authentication commands (CLI login approval).
 */

import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';

export const authCommand = new SlashCommandBuilder()
  .setName('auth')
  .setDescription('Authentication commands')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('login')
      .setDescription('Approve a Pawthy CLI login request')
      .addStringOption((option) =>
        option
          .setName('code')
          .setDescription('The 9-character code from the CLI (e.g., ABCD-1234)')
          .setRequired(true)
          .setMaxLength(9)
      )
  );

/**
 * Handle /auth subcommands.
 */
export async function handleAuthCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'login') {
    await handleAuthLogin(interaction, context);
    return;
  }

  await interaction.reply({
    content: `Unknown subcommand: ${subcommand}`,
    ephemeral: true,
  });
}

/**
 * Handle the /auth login subcommand.
 */
export async function handleAuthLogin(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const code = interaction.options.getString('code', true).toUpperCase().trim();
  const userId = interaction.user.id;

  try {
    const success = await context.services.auth.approveSession(code, userId);

    if (success) {
      await interaction.reply({
        content: `✅ Successfully authenticated! Your CLI session is now approved.\nLinked to Discord User: <@${userId}>`,
        ephemeral: true,
      });

      logger.info('Approved CLI session', {
        userId,
        userCode: code,
      });
    } else {
      await interaction.reply({
        content:
          '❌ Failed to approve session. The code may be invalid, expired, or already approved.',
        ephemeral: true,
      });
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error('Error handling auth login', {
        message: error.message,
        stack: error.stack,
      });
    } else {
      logger.error('Error handling auth login', { error: String(error) });
    }
    await interaction.reply({
      content: '❌ An internal error occurred while processing your login.',
      ephemeral: true,
    });
  }
}
