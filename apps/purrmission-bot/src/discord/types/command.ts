import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    SlashCommandSubcommandsOnlyBuilder,
    SlashCommandOptionsOnlyBuilder
} from 'discord.js';
import type { Services } from '../../domain/services.js';

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
    execute: (interaction: ChatInputCommandInteraction, services: Services) => Promise<void>;
}
