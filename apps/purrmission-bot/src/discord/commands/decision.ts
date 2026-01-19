import { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';
import type { ApprovalDecision } from '../../domain/models.js';

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
            if (request && request.discordChannelId && request.discordMessageId) {
                try {
                    const channel = await interaction.client.channels.fetch(request.discordChannelId);
                    if (channel && channel.isTextBased()) {
                        const message = await channel.messages.fetch(request.discordMessageId);
                        if (message) {
                            const embed = message.embeds[0];
                            // Remove buttons by passing empty components
                            // Append decision to content or modify embed title?
                            // Let's modify the embed title to include status
                            const newEmbed = {
                                ...embed.data,
                                title: `${embed.title} [${actionPastTense}]`,
                                color: decision === 'APPROVE' ? 0x00FF00 : 0xFF0000
                            };

                            await message.edit({
                                content: `**Request ${actionPastTense}** by <@${userId}>`,
                                embeds: [newEmbed],
                                components: []
                            });
                        }
                    }
                } catch (err) {
                    logger.error('Failed to update original discord message', { err, requestId });
                }
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
