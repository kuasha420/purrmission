/**
 * Handler for /check-dm-connectivity command.
 *
 * Tests if the bot can send Direct Messages to the user and provides
 * troubleshooting steps on failure.
 */

import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../../logging/logger.js';

export const checkDmConnectivityCommand = new SlashCommandBuilder()
  .setName('check-dm-connectivity')
  .setDescription('Test Direct Message delivery and troubleshoot connectivity');

/**
 * Handle the /check-dm-connectivity command.
 */
export async function handleCheckDmConnectivityCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const userId = interaction.user.id;

  logger.info('Testing DM connectivity for user', { userId });

  // Defer reply ephemerally as it requires API call that can take a moment
  await interaction.deferReply({ ephemeral: true });

  try {
    const dm = await interaction.user.createDM();
    await dm.send({
      content: [
        '🐾 **Purrmission DM Connectivity Test**',
        '',
        '✅ Successfully received direct message!',
        'You are all set to receive approval notifications and OTP codes.',
      ].join('\n'),
    });

    await interaction.editReply({
      content:
        '✅ **DM Connectivity Test Succeeded!** A test direct message has been sent to you. Please check your DMs.',
    });
  } catch (error) {
    logger.warn('Failed to send test DM to user', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    await interaction.editReply({
      content: [
        '❌ **DM Connectivity Test Failed!**',
        '',
        'I was unable to send you a direct message. Please check your Discord settings:',
        '1. Go to **User Settings** -> **Privacy & Safety**.',
        '2. Enable **"Allow direct messages from server members"** for this server.',
        "3. Make sure you haven't blocked the bot.",
      ].join('\n'),
    });
  }
}
