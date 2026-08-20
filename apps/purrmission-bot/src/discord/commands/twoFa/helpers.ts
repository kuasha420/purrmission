import type { ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../../../logging/logger.js';

/**
 * Send a DM to the user with message lines.
 * If DM fails, log error and send ephemeral fallback message.
 */
export async function sendDmOrFallback(
  interaction: ChatInputCommandInteraction,
  messageLines: string[],
  successMessage: string,
  logErrorContext: string
): Promise<void> {
  try {
    const dm = await interaction.user.createDM();
    await dm.send(messageLines.join('\n'));
    await interaction.reply({
      content: successMessage,
      ephemeral: true,
    });
  } catch (error) {
    logger.error(logErrorContext, error);
    await interaction.reply({
      content:
        "⚠️ I couldn't send you a DM (DMs may be disabled). Please enable DMs from this server and try again.",
      ephemeral: true,
    });
  }
}
