/**
 * Handler for /purrmission request-access command.
 *
 * Allows users to manually request access to a protected resource.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';
import { createDiscordPrincipal } from '../../domain/principal.js';

/**
 * Handle the /purrmission request-access command.
 *
 * Creates an approval request for the specified resource.
 */
export async function handleRequestAccess(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  try {
    const resourceId = interaction.options.getString('resource-id', true);
    const userId = interaction.user.id;
    const { services, repositories } = context;

    // Verify resource exists
    const resource = await repositories.resources.findById(resourceId);
    if (!resource) {
      await interaction.reply({
        content: '❌ Resource not found.',
        ephemeral: true,
      });
      return;
    }

    const principal = createDiscordPrincipal(userId, interaction.id);

    // Create new approval request via DomainPorts (which enqueues outbox events atomically)
    const result = await services.ports.createApprovalRequest(
      principal,
      resourceId,
      'MANUAL_REQUEST',
      null,
      {
        reason: `Requested via Discord command by <@${userId}>`,
      },
      interaction.id
    );

    if (!result.success || !result.request) {
      logger.error('Failed to create approval request', { error: result.error });
      await interaction.reply({
        content: `❌ Failed to create access request: ${result.error ?? 'Unknown error'}`,
        ephemeral: true,
      });
      return;
    }

    logger.info('Approval request created via Discord command', {
      requestId: result.request.id,
      resourceId,
      userId,
    });

    await interaction.reply({
      content: [
        `📝 **Access request submitted for ${resource.name}**`,
        '',
        `Request ID: \`${result.request.id}\``,
        '',
        '_Guardians have been notified. You will be contacted when a decision is made._',
      ].join('\n'),
      ephemeral: true,
    });
  } catch (error) {
    logger.error('Error handling requestAccess command', { error });
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ An unexpected error occurred while requesting access.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '❌ An unexpected error occurred while requesting access.',
          ephemeral: true,
        });
      }
    } catch (replyError) {
      logger.error('Failed to send error reply in requestAccess command', { error: replyError });
    }
  }
}
