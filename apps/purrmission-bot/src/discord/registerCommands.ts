/**
 * Discord slash command registration script.
 *
 * Run this script to register/update slash commands with Discord.
 * Usage: yarn discord:deploy-commands
 */

import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { commands } from './commands/index.js';
import { logger } from '../logging/logger.js';

async function deployCommands(): Promise<void> {
  logger.info('Starting command deployment...');

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  try {
    logger.info(`Deploying ${commands.length} commands to guild ${env.DISCORD_GUILD_ID}...`);

    // Deploy commands to a specific guild (faster, recommended for development)
    const data = await rest.put(
      Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
      { body: commands }
    );

    if (Array.isArray(data)) {
      logger.info(`Successfully deployed ${data.length} commands!`);

      for (const command of data) {
        const cmd = command as { name: string; id: string };
        logger.info(`  - /${cmd.name} (${cmd.id})`);
      }
    }

    logger.info('Command deployment complete!');

    // TODO: For production, deploy global commands instead:
    // await rest.put(
    //   Routes.applicationCommands(env.DISCORD_CLIENT_ID),
    //   { body: commands }
    // );
    // Note: Global commands take up to 1 hour to propagate
  } catch (error) {
    logger.error('Failed to deploy commands', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Run the deployment
deployCommands();
