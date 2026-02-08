import { createDiscordClient } from './discord/client.js';
import { config } from './config.js';
import { logger } from './logging/logger.js';

async function main() {
    logger.info('Starting ModMail Bot...');

    try {
        const client = createDiscordClient();

        if (!config.discordToken) {
            throw new Error('Missing DISCORD_TOKEN');
        }

        await client.login(config.discordToken);
    } catch (error) {
        logger.error('Fatal error during startup', {
            error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
    }
}

main();
