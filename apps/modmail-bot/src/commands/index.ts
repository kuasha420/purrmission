import {
    ChatInputCommandInteraction,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { setupCommand } from './modmail/setup.js';
import { logger } from '../logging/logger.js';

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
    setupCommand.data.toJSON(),
];

export async function handleSlashCommand(
    interaction: ChatInputCommandInteraction
): Promise<void> {
    const { commandName } = interaction;

    switch (commandName) {
        case 'modmail-setup':
            await setupCommand.execute(interaction);
            break;
        default:
            logger.warn(`Unknown command received: ${commandName}`);
            await interaction.reply({
                content: `Unknown command: ${commandName}`,
                ephemeral: true,
            });
    }
}
