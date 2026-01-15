/**
 * Handler for /purrmission guardian remove command.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';

export async function handleRemoveGuardian(
    interaction: ChatInputCommandInteraction,
    services: Services
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const targetUser = interaction.options.getUser('user', true);
    const callerId = interaction.user.id;

    logger.info('Removing guardian from resource', {
        resourceId,
        targetUserId: targetUser.id,
        callerId,
    });

    try {
        const result = await services.resource.removeGuardian(resourceId, callerId, targetUser.id);

        if (!result.success) {
            await interaction.reply({
                content: `❌ ${result.error}`,
                ephemeral: true,
            });
            return;
        }

        await interaction.reply({
            content: `✅ Removed **${targetUser.tag}** (<@${targetUser.id}>) from guardians of \`${resourceId}\`.`,
            ephemeral: true,
        });

    } catch (error) {
        logger.error('Failed to remove guardian', {
            resourceId,
            targetUserId: targetUser.id,
            error: error instanceof Error ? error.message : String(error),
        });

        await interaction.reply({
            content: '❌ Failed to remove guardian. Please try again.',
            ephemeral: true,
        });
    }
}
