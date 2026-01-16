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
            // TODO: Update the original request message if possible (requires message ID storage)
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
