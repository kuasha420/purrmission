/**
 * Handler for approval button interactions.
 *
 * Processes approve/deny button clicks for approval requests.
 */

import {
  type ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Services } from '../../domain/services.js';
import type { ApprovalDecision } from '../../domain/models.js';
import { logger } from '../../logging/logger.js';

/**
 * Parse the custom ID to extract action and request ID.
 *
 * Format: purrmission:<action>:<requestId>
 */
function parseCustomId(customId: string): { action: ApprovalDecision; requestId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'purrmission') {
    return null;
  }

  const [, actionStr, requestId] = parts;
  const action = actionStr.toUpperCase() as ApprovalDecision;

  if (action !== 'APPROVE' && action !== 'DENY') {
    return null;
  }

  return { action, requestId };
}

/**
 * Handle approval button interactions.
 *
 * @param interaction - The button interaction
 * @param services - Application services
 */
export async function handleApprovalButton(
  interaction: ButtonInteraction,
  services: Services
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    logger.warn('Invalid button customId', { customId: interaction.customId });
    await interaction.reply({
      content: '❌ Invalid button action.',
      ephemeral: true,
    });
    return;
  }

  const { action, requestId } = parsed;
  const userId = interaction.user.id;

  logger.info('Processing approval button', {
    action,
    requestId,
    userId,
  });

  // Defer the reply while we process
  await interaction.deferUpdate();

  try {
    // Record the decision
    const result = await services.approval.recordDecision(requestId, action, userId);

    if (!result.success) {
      await interaction.followUp({
        content: `❌ ${result.error}`,
        ephemeral: true,
      });
      return;
    }

    // Update the original message to show the decision
    const statusEmoji = action === 'APPROVE' ? '✅' : '❌';
    const statusText = action === 'APPROVE' ? 'APPROVED' : 'DENIED';
    const statusColor = action === 'APPROVE' ? 0x00ff00 : 0xff0000;

    // Get the original embed and update it
    const originalEmbed = interaction.message.embeds[0];
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(statusColor)
      .addFields({
        name: 'Decision',
        value: `${statusEmoji} **${statusText}** by <@${userId}>`,
        inline: false,
      })
      .setTimestamp();

    // Disable the buttons
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`purrmission:approve:${requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`purrmission:deny:${requestId}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true)
    );

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });

    // Handle callback if configured
    if (result.action?.type === 'CALL_CALLBACK_URL') {
      logger.info('Callback URL configured', {
        url: result.action.url,
        status: result.action.status,
      });
      // TODO: Implement actual HTTP callback
    }

    logger.info('Approval button processed', { requestId, action, userId });
  } catch (error) {
    logger.error('Failed to process approval button', { requestId, error });

    await interaction.followUp({
      content: '❌ Failed to process your decision. Please try again.',
      ephemeral: true,
    });
  }
}

/**
 * Create the approval message components (buttons).
 */
export function createApprovalButtons(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`purrmission:approve:${requestId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`purrmission:deny:${requestId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌')
  );
}

/**
 * Create an embed for an approval request.
 */
export function createApprovalEmbed(
  resourceName: string,
  context: Record<string, unknown>,
  expiresAt: Date | null
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('🔐 Approval Request')
    .setDescription(`A new approval request has been received for **${resourceName}**.`)
    .setColor(0xffa500) // Orange for pending
    .addFields({
      name: 'Context',
      value: `\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``,
      inline: false,
    })
    .setTimestamp();

  if (expiresAt) {
    embed.addFields({
      name: 'Expires',
      value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`,
      inline: true,
    });
  }

  return embed;
}
