import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from '../types/command.js';
import { logger } from '../../logging/logger.js';
import type { Services } from '../../domain/services.js';

export const data = new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Deny a pending request')
    .addStringOption(option =>
        option
            .setName('request-id')
            .setDescription('The ID of the request to deny')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
    const requestId = interaction.options.getString('request-id', true);
    const userId = interaction.user.id;

    try {
        const result = await services.approval.recordDecision(requestId, 'DENY', userId);

        if (result.success) {
            await interaction.reply({
                content: `🚫 Request DENIED.\nRequest ID: ${requestId}`,
                ephemeral: true
            });
        } else {
            await interaction.reply({
                content: `❌ Failed to deny request: ${result.error}`,
                ephemeral: true
            });
        }
    } catch (error) {
        logger.error('Error executing deny command', { err: error, requestId, userId });
        await interaction.reply({
            content: 'An unexpected error occurred while processing your denial.',
            ephemeral: true
        });
    }
}

export default { data, execute } satisfies Command;
