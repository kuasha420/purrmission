/**
 * Slash command definitions and routing.
 *
 * This module exports command definitions for registration and
 * provides a handler function for routing commands to their implementations.
 */

import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Services } from '../../domain/services.js';
import { handleRegisterResource } from './registerResource.js';
import { handleAddGuardian } from './addGuardian.js';
import { handlePurrmissionCommand, purrmissionCommand } from './twoFaAdd.js';
import { logger } from '../../logging/logger.js';

/**
 * All slash command definitions for registration.
 */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
    new SlashCommandBuilder()
        .setName('purrmission-register-resource')
        .setDescription('Register a new protected resource')
        .addStringOption((option) =>
            option
                .setName('name')
                .setDescription('Name of the resource to protect')
                .setRequired(true)
                .setMaxLength(100)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('purrmission-add-guardian')
        .setDescription('Add a guardian to a protected resource')
        .addStringOption((option) =>
            option
                .setName('resource-id')
                .setDescription('ID of the resource')
                .setRequired(true)
        )
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('User to add as guardian')
                .setRequired(true)
        )
        .toJSON(),

    purrmissionCommand.toJSON(),
];

/**
 * Route slash commands to their handlers.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
export async function handleSlashCommand(
    interaction: ChatInputCommandInteraction,
    services: Services
): Promise<void> {
    const { commandName } = interaction;

    switch (commandName) {
        case 'purrmission-register-resource':
            await handleRegisterResource(interaction, services);
            break;

        case 'purrmission-add-guardian':
            await handleAddGuardian(interaction, services);
            break;

        case 'purrmission':
            await handlePurrmissionCommand(interaction);
            break;

        default:
            logger.warn('Unknown command received', { commandName });
            await interaction.reply({
                content: `Unknown command: ${commandName}`,
                ephemeral: true,
            });
    }
}
