import {
    Client,
    GatewayIntentBits,
    Events,
    Interaction,
    Partials,
    Message,
} from 'discord.js';
import { logger } from '../logging/logger.js';
import { handleSlashCommand } from '../commands/index.js';
import { handleMessageCreate } from '../events/messageCreate.js';
import { handleInteractionCreate } from '../events/interactionCreate.js';

export function createDiscordClient(): Client {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildBans,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildInvites,
        ],
        partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (c) => {
        logger.info(`Ready! Logged in as ${c.user.tag}`);
    });

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
        try {
            if (interaction.isChatInputCommand()) {
                await handleSlashCommand(interaction);
            } else if (interaction.isButton()) {
                await handleInteractionCreate(interaction);
            }
        } catch (error) {
            logger.error('Error handling interaction', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    client.on(Events.MessageCreate, async (message: Message) => {
        try {
            await handleMessageCreate(message);
        } catch (error) {
            logger.error('Error handling message', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    return client;
}
