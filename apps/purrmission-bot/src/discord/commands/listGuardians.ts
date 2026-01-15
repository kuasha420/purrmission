/**
 * Handler for /purrmission guardian list command.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';

export async function handleListGuardians(
    interaction: ChatInputCommandInteraction,
    services: Services
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const callerId = interaction.user.id;

    try {
        const result = await services.resource.listGuardians(resourceId, callerId);

        if (!result.success || !result.guardians) {
            await interaction.reply({
                content: `❌ ${result.error || 'Failed to list guardians'}`,
                ephemeral: true,
            });
            return;
        }

        if (result.guardians.length === 0) {
            await interaction.reply({
                content: `ℹ️ No guardians found for resource \`${resourceId}\`.`,
                ephemeral: true,
            });
            return;
        }

        const guardianList = result.guardians
            .map(g => `- <@${g.discordUserId}> (\`${g.role}\`)`)
            .join('\n');

        await interaction.reply({
            content: `**Guardians for \`${resourceId}\`**:\n${guardianList}`,
            ephemeral: true,
        });

    } catch (error) {
        logger.error('Failed to list guardians', {
            resourceId,
            error: error instanceof Error ? error.message : String(error),
        });

        await interaction.reply({
            content: '❌ Failed to list guardians. Please try again.',
            ephemeral: true,
        });
    }
}
