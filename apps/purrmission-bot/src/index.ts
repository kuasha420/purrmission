/**
 * Purrmission Bot - Main Entry Point
 */

import { env } from './config/env.js';
import { logger } from './logging/logger.js';
import {

  PrismaTOTPRepository,
  PrismaResourceRepository,
  PrismaAuditRepository,
  PrismaGuardianRepository,
  PrismaApprovalRequestRepository,
  PrismaResourceFieldRepository,
  PrismaAuthRepository,
  PrismaProjectRepository,
} from './domain/repositories.js';
import { createServices } from './domain/services.js';
import { createDiscordClient } from './discord/client.js';
import { startHttpServer } from './http/server.js';
import { getPrismaClient } from './infra/prismaClient.js';
import { validateEncryptionConfig } from './infra/crypto.js';
import { StatusService } from './domain/status.js';

/**
 * Main application bootstrap.
 */
async function main(): Promise<void> {
  logger.info('🐱 Starting Purrmission Bot...');

  try {
    validateEncryptionConfig();
    logger.info('✅ Encryption configuration validated');
  } catch (error) {
    logger.error('❌ Critical security failure:', error);
    process.exit(1);
  }

  logger.info('Initializing repositories...');

  // Wire up Prisma for production persistence
  const prisma = getPrismaClient();

  const repositories = {
    resources: new PrismaResourceRepository(prisma),
    guardians: new PrismaGuardianRepository(prisma),
    approvalRequests: new PrismaApprovalRequestRepository(prisma),
    totp: new PrismaTOTPRepository(prisma),
    resourceFields: new PrismaResourceFieldRepository(prisma),
    audit: new PrismaAuditRepository(prisma),
    auth: new PrismaAuthRepository(prisma),
    projects: new PrismaProjectRepository(prisma),
  };

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

  // Announce online status
  const statusService = new StatusService();
  // Don't await this to avoid blocking startup if Discord API is slow
  statusService.sendOnlineAnnouncement(discordClient).catch(err => {
    logger.error('Failed to send ready announcement', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
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

    // Announce offline
    try {
      await statusService.sendOfflineAnnouncement(discordClient, signal);
    } catch (err) {
      logger.warn('Failed to send offline announcement during shutdown', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

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
