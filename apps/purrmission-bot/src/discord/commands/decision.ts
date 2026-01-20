import { ChatInputCommandInteraction, Colors } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';
import type { ApprovalDecision, ApprovalRequest } from '../../domain/models.js';

/**
 * Handle approval/denial decision commands.
 * Shared logic for /approve and /deny to avoid duplication.
 */
export async function handleDecisionCommand(
    interaction: ChatInputCommandInteraction,
    services: Services,
    decision: ApprovalDecision
): Promise<void> {
    const requestId = interaction.options.getString('request-id', true);
    const userId = interaction.user.id;
    const actionPastTense = decision === 'APPROVE' ? 'APPROVED' : 'DENIED';
    const icon = decision === 'APPROVE' ? '✅' : '🚫'; // correction: DENY usually 🚫 or ❌

    try {
        const result = await services.approval.recordDecision(requestId, decision, userId);

        if (result.success) {
            await interaction.reply({
                content: `${icon} Request ${actionPastTense}.\nRequest ID: ${requestId}`,
                ephemeral: true,
            });

            // Update original message
            const { request } = result;
            if (request) {
                await updateDiscordMessage(interaction, request, decision, userId, actionPastTense);
            }


            // Handle Callback logic
            if (result.action && result.action.type === 'CALL_CALLBACK_URL') {
                const { url, status } = result.action;
                try {
                    // Fire and forget fetch
                    fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            requestId,
                            status,
                            resolvedBy: userId,
                            resolvedAt: new Date().toISOString(),
                            context: request?.context
                        })
                    }).then(res => {
                        if (!res.ok) {
                            logger.warn('Callback URL returned non-200 status', { url, status: res.status });
                        }
                    }).catch(err => {
                        logger.error('Failed to call callback URL', { url, err });
                    });
                } catch (err) {
                    logger.error('Error initiating callback request', { err });
                }
            }

        } else {
            await interaction.reply({
                content: `❌ Failed to ${decision.toLowerCase()} request: ${result.error}`,
                ephemeral: true,
            });
        }
    } catch (error) {
        logger.error(`Error executing ${decision.toLowerCase()} command`, {
            err: error,
            requestId,
            userId,
        });

        const errorMessage = `An unexpected error occurred while processing your ${decision.toLowerCase()}.`;
        const replyOptions = { content: errorMessage, ephemeral: true };

        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(replyOptions);
            } else {
                await interaction.reply(replyOptions);
            }
        } catch (replyError) {
            logger.error('Failed to send error response', { err: replyError });
        }
    }
}

/**
 * Updates the original Discord request message with the decision.
 */
async function updateDiscordMessage(
    interaction: ChatInputCommandInteraction,
    request: ApprovalRequest,
    decision: ApprovalDecision,
    userId: string,
    actionPastTense: string
): Promise<void> {
    if (!request.discordChannelId || !request.discordMessageId) {
        return;
    }

    try {
        const channel = await interaction.client.channels.fetch(request.discordChannelId);
        if (!channel?.isTextBased()) {
            logger.warn('Could not find a text-based channel to update the message.', {
                channelId: request.discordChannelId,
                requestId: request.id
            });
            return;
        }

        const message = await channel.messages.fetch(request.discordMessageId);
        const embed = message.embeds[0];

        if (!embed) {
            logger.warn('Original message has no embeds to update.', {
                requestId: request.id,
                messageId: message.id
            });
            // Fallback: just update content and remove buttons
            await message.edit({
                content: `**Request ${actionPastTense}** by <@${userId}>`,
                components: []
            });
            return;
        }

        const newEmbed = {
            ...embed.data,
            title: `${embed.title} [${actionPastTense}]`,
            color: decision === 'APPROVE' ? Colors.Green : Colors.Red
        };

        await message.edit({
            content: `**Request ${actionPastTense}** by <@${userId}>`,
            embeds: [newEmbed],
            components: []
        });

    } catch (err) {
        logger.error('Failed to update original discord message', { err, requestId: request.id });
    }
}
