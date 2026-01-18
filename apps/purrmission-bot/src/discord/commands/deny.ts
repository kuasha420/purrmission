import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { Command } from '../types/command.js';
import { handleDecisionCommand } from './decision.js';

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
    await handleDecisionCommand(interaction, services, 'DENY');
}

export default { data, execute } satisfies Command;
