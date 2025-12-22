/**
 * Handler for approval button interactions.
 *
 * Processes approve/deny button clicks for approval requests.
 */

import {
  type ButtonInteraction,
  type Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Services } from '../../domain/services.js';
import type { ApprovalDecision, AccessRequestContext } from '../../domain/models.js';
import type { Repositories } from '../../domain/repositories.js';
import { generateTOTPCode } from '../../domain/totp.js';
import { logger } from '../../logging/logger.js';

/**
 * Type guard for AccessRequestContext.
 * Validates that the context has the expected shape for field/2FA access requests.
 */
function isAccessRequestContext(context: unknown): context is AccessRequestContext {
  const ctx = context as AccessRequestContext;
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.requesterId !== 'string' ||
    typeof ctx.description !== 'string' ||
    typeof ctx.type !== 'string'
  ) {
    return false;
  }

  // Validate type-specific fields
  if (ctx.type === 'FIELD_ACCESS') {
    // FIELD_ACCESS requires a non-empty fieldName
    return typeof ctx.fieldName === 'string' && ctx.fieldName.trim().length > 0;
  }

  if (ctx.type === 'TOTP_ACCESS') {
    return true;
  }

  return false;
}

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
 * @param repositories - Repositories for data access
 * @param discordClient - Discord client for sending DMs
 */
export async function handleApprovalButton(
  interaction: ButtonInteraction,
  services: Services,
  repositories: Repositories,
  discordClient: Client
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

    // If approved, reveal the data to the requester
    if (action === 'APPROVE' && result.request) {
      const context = result.request.context;
      if (isAccessRequestContext(context)) {
        await revealAccessToRequester(
          context,
          result.request.resourceId,
          repositories,
          services,
          discordClient
        );
      }
    }

    // If denied, notify the requester via DM
    if (action === 'DENY' && result.request) {
      const context = result.request.context;
      if (isAccessRequestContext(context)) {
        try {
          const user = await discordClient.users.fetch(context.requesterId);
          const dm = await user.createDM();
          await dm.send('❌ Your access request was denied by a guardian.');
        } catch (dmError) {
          logger.warn('Failed to send denial DM to requester', {
            requestId,
            error: dmError,
          });
        }
      }
    }

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
 * Reveal the requested data to the requester after approval.
 */
async function revealAccessToRequester(
  context: AccessRequestContext,
  resourceId: string,
  repositories: Repositories,
  services: Services,
  discordClient: Client
): Promise<void> {
  try {
    const user = await discordClient.users.fetch(context.requesterId);
    const dm = await user.createDM();
    const resource = await repositories.resources.findById(resourceId);
    const resourceName = resource?.name ?? 'Unknown Resource';

    if (context.type === 'FIELD_ACCESS' && context.fieldName) {
      // Reveal field value
      const field = await repositories.resourceFields.findByResourceAndName(resourceId, context.fieldName);
      if (field) {
        await dm.send(
          [
            '✅ **Access Approved!**',
            '',
            `Your request for field **${context.fieldName}** on **${resourceName}** was approved.`,
            '',
            `**${field.name}:** \`${field.value}\``,
            '',
            '_Keep this value secure._',
          ].join('\n')
        );
        logger.info('Revealed field value to requester', {
          requesterId: context.requesterId,
          resourceId,
          fieldName: context.fieldName,
        });
      } else {
        await dm.send(`✅ Your access request for field **${context.fieldName}** on **${resourceName}** was approved, but the field could not be found. It may have been deleted.`);
        logger.warn('Approved field access request for a non-existent field', {
          requesterId: context.requesterId,
          resourceId,
          fieldName: context.fieldName,
        });
      }
    } else if (context.type === 'TOTP_ACCESS') {
      // Reveal TOTP code
      const linkedAccount = await services.resource.getLinkedTOTPAccount(resourceId);
      if (linkedAccount) {
        const code = generateTOTPCode(linkedAccount);
        await dm.send(
          [
            '✅ **Access Approved!**',
            '',
            `Your request for 2FA code on **${resourceName}** was approved.`,
            '',
            `**${code}**`,
            '',
            `_Account: ${linkedAccount.accountName}_`,
            '_Code is time-based and will expire soon._',
          ].join('\n')
        );
        logger.info('Revealed TOTP code to requester', {
          requesterId: context.requesterId,
          resourceId,
          totpAccountId: linkedAccount.id,
        });
      } else {
        await dm.send(`✅ Your access request for 2FA on **${resourceName}** was approved, but no 2FA account is linked to it. It may have been unlinked.`);
        logger.warn('Approved 2FA access request for a resource with no linked account', {
          requesterId: context.requesterId,
          resourceId,
        });
      }
    }
  } catch (error) {
    logger.error('Failed to reveal access to requester', {
      context,
      resourceId,
      error,
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

/**
 * Create an embed for a field/2FA access request.
 */
export function createAccessRequestEmbed(
  resourceName: string,
  context: AccessRequestContext,
  expiresAt: Date | null
): EmbedBuilder {
  const typeLabel = context.type === 'FIELD_ACCESS' ? '📝 Field Access' : '🔑 2FA Code Access';
  const description = context.type === 'FIELD_ACCESS'
    ? `<@${context.requesterId}> is requesting access to field **${context.fieldName}** on **${resourceName}**.`
    : `<@${context.requesterId}> is requesting the linked 2FA code for **${resourceName}**.`;

  const embed = new EmbedBuilder()
    .setTitle(`🔐 ${typeLabel} Request`)
    .setDescription(description)
    .setColor(0xffa500) // Orange for pending
    .addFields({
      name: 'Requester',
      value: `<@${context.requesterId}>`,
      inline: true,
    })
    .setTimestamp();

  if (context.description) {
    embed.addFields({
      name: 'Reason',
      value: context.description,
      inline: false,
    });
  }

  if (expiresAt) {
    embed.addFields({
      name: 'Expires',
      value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`,
      inline: true,
    });
  }

  return embed;
}

