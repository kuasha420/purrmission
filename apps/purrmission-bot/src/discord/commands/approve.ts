import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from '../types/command.js';
import { logger } from '../../logging/logger.js';

export const data = new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a pending request')
    .addStringOption(option =>
        option
            .setName('request-id')
            .setDescription('The ID of the request to approve')
            .setRequired(true)
    );

import type { Services } from '../../domain/services.js';

export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
    const requestId = interaction.options.getString('request-id', true);
    const userId = interaction.user.id;

    try {
        const result = await services.approval.recordDecision(requestId, 'APPROVE', userId);

        if (result.success) {
            await interaction.reply({
                content: `✅ Request APPROVED.\nRequest ID: ${requestId}`,
                ephemeral: true
            });
            // TODO: Update the original request message if possible (requires message ID storage)
        } else {
            await interaction.reply({
                content: `❌ Failed to approve request: ${result.error}`,
                ephemeral: true
            });
        }
    } catch (error) {
        logger.error('Error executing approve command', { err: error, requestId, userId });
        await interaction.reply({
            content: 'An unexpected error occurred while processing your approval.',
            ephemeral: true
        });
    }
}

export default { data, execute } satisfies Command;
