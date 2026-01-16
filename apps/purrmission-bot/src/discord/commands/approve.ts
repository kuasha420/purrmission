import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { Command } from '../types/command.js';
import { handleDecisionCommand } from './decision.js';

export const data = new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a pending request')
    .addStringOption(option =>
        option
            .setName('request-id')
            .setDescription('The ID of the request to approve')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
    await handleDecisionCommand(interaction, services, 'APPROVE');
}

export default { data, execute } satisfies Command;
