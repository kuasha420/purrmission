/**
 * Purrmission Bot - Main Entry Point
 */

import { env } from './config/env.js';
import { logger } from './logging/logger.js';
import { createInMemoryRepositories, PrismaTOTPRepository, PrismaResourceRepository } from './domain/repositories.js';
import { createServices } from './domain/services.js';
import { createDiscordClient } from './discord/client.js';
import { startHttpServer } from './http/server.js';
import { getPrismaClient } from './infra/prismaClient.js';

/**
 * Main application bootstrap.
 */
async function main(): Promise<void> {
  logger.info('🐱 Starting Purrmission Bot...');

  logger.info('Initializing repositories...');
  const repositories = createInMemoryRepositories();

  // Wire up Prisma for production persistence
  const prisma = getPrismaClient();
  repositories.totp = new PrismaTOTPRepository(prisma);
  repositories.resources = new PrismaResourceRepository(prisma);

  logger.info('Initializing services...');
  const services = createServices({ repositories });

  logger.info('Creating Discord client...');
  const discordClient = createDiscordClient({ services, repositories });

  logger.info('Logging in to Discord...');
  await discordClient.login(env.DISCORD_BOT_TOKEN);

  // Wait for client to be ready
  await new Promise<void>((resolve) => {
    if (discordClient.isReady()) {
      resolve();
    } else {
      discordClient.once('ready', () => resolve());
    }
  });

  logger.info('Starting HTTP server...');
  await startHttpServer(env.APP_PORT, {
    services,
    discordClient,
  });

  // Log startup summary
  logger.info('========================================');
  logger.info('🐱 Purrmission Bot is ready!');
  logger.info('========================================');
  logger.info(`Bot User: ${discordClient.user?.tag}`);
  logger.info(`Guild ID: ${env.DISCORD_GUILD_ID}`);
  logger.info(`HTTP Port: ${env.APP_PORT}`);
  logger.info(`API Endpoint: http://localhost:${env.APP_PORT}/api/requests`);
  logger.info('========================================');

  // Graceful shutdown handling
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      discordClient.destroy();
      logger.info('Discord client disconnected');
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run the application
main().catch((error) => {
  logger.error('Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
