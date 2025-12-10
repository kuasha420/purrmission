/**
 * Discord.js client setup and configuration.
 *
 * This module creates and configures the Discord client with the
 * appropriate intents and event handlers.
 */

import {
    Client,
    GatewayIntentBits,
    Events,
    type Interaction,
    type ChatInputCommandInteraction,
    type ButtonInteraction,
    type AutocompleteInteraction,
} from 'discord.js';
import { logger } from '../logging/logger.js';
import type { Services } from '../domain/services.js';
import { handleSlashCommand, handleAutocomplete } from './commands/index.js';
import { handleApprovalButton } from './interactions/approvalButtons.js';

import type { Repositories } from '../domain/repositories.js';

/**
 * Dependencies for the Discord client.
 */
export interface DiscordClientDeps {
    services: Services;
    repositories: Repositories;
}

/**
 * Create and configure the Discord client.
 *
 * @param deps - Dependencies for command/interaction handlers
 * @returns Configured Discord client
 */
export function createDiscordClient(deps: DiscordClientDeps): Client {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            // Note: MessageContent intent requires privileged intent approval
            // for production bots. Uncomment if needed and approved.
            // GatewayIntentBits.MessageContent,
        ],
    });

    // Ready event
    client.once(Events.ClientReady, (readyClient) => {
        logger.info(`Discord bot ready! Logged in as ${readyClient.user.tag}`);
        logger.info(`Bot is in ${readyClient.guilds.cache.size} guild(s)`);
    });

    // Interaction handler
    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
        try {
            // Handle slash commands
            if (interaction.isChatInputCommand()) {
                await handleChatInputCommand(interaction, deps);
                return;
            }

            // Handle autocomplete
            if (interaction.isAutocomplete()) {
                await handleAutocomplete(interaction, {
                    services: deps.services,
                    repositories: deps.repositories,
                });
                return;
            }

            // Handle button interactions
            if (interaction.isButton()) {
                await handleButtonInteraction(interaction, deps);
                return;
            }

            // TODO: Handle other interaction types as needed
            // - Select menus
            // - Modal submissions
            // - Autocomplete
        } catch (error) {
            logger.error('Error handling interaction', {
                interactionId: interaction.id,
                error: error instanceof Error ? error.message : String(error),
            });

            // Try to respond with an error message
            try {
                if (interaction.isRepliable()) {
                    const errorMessage = 'An error occurred while processing your request.';
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: errorMessage, ephemeral: true });
                    } else {
                        await interaction.reply({ content: errorMessage, ephemeral: true });
                    }
                }
            } catch {
                // Ignore errors when trying to send error response
            }
        }
    });

    // Error event
    client.on(Events.Error, (error) => {
        logger.error('Discord client error', { error: error.message });
    });

    // Warning event
    client.on(Events.Warn, (message) => {
        logger.warn('Discord client warning', { message });
    });

    return client;
}

/**
 * Handle chat input (slash) commands.
 */
async function handleChatInputCommand(
    interaction: ChatInputCommandInteraction,
    deps: DiscordClientDeps
): Promise<void> {
    logger.debug('Received slash command', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
    });

    await handleSlashCommand(interaction, {
        services: deps.services,
        repositories: deps.repositories,
    });
}

/**
 * Handle button interactions.
 */
async function handleButtonInteraction(
    interaction: ButtonInteraction,
    deps: DiscordClientDeps
): Promise<void> {
    // Check if this is a purrmission button
    if (interaction.customId.startsWith('purrmission:')) {
        logger.debug('Received approval button interaction', {
            customId: interaction.customId,
            userId: interaction.user.id,
        });

        await handleApprovalButton(interaction, deps.services);
        return;
    }

    // Ignore other button interactions
    logger.debug('Ignoring unknown button interaction', {
        customId: interaction.customId,
    });
}
