/**
 * Handler for /purrmission request-access command.
 *
 * Allows users to manually request access to a protected resource.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';

/**
 * Handle the /purrmission request-access command.
 *
 * Creates an approval request for the specified resource.
 */
export async function handleRequestAccess(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
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

    // Check if user is already a guardian (they don't need to request access)
    const isGuardian = await services.resource.isGuardian(resourceId, userId);
    if (isGuardian) {
        await interaction.reply({
            content: `✅ You are already a guardian of **${resource.name}**. No approval needed.`,
            ephemeral: true,
        });
        return;
    }

    // Check for existing pending approval
    const existingApproval = await services.approval.findActiveApproval(resourceId, userId);
    if (existingApproval && existingApproval.status === 'PENDING') {
        await interaction.reply({
            content: [
                `⏳ You already have a pending access request for **${resource.name}**.`,
                '',
                `Request ID: \`${existingApproval.id}\``,
                '',
                '_Please wait for a guardian to approve or deny your request._',
            ].join('\n'),
            ephemeral: true,
        });
        return;
    }

    // Create new approval request
    const result = await services.approval.createApprovalRequest({
        resourceId,
        context: {
            requesterId: userId,
            action: 'MANUAL_REQUEST',
            reason: `Requested via Discord command by <@${userId}>`,
        },
    });

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
}
