/**
 * Discord.js client setup and configuration.
 *
 * This module creates and configures the Discord client with the
 * appropriate intents and event handlers.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { logger } from '../logging/logger.js';
import type { Services } from '../domain/services.js';
import { handleSlashCommand, handleAutocomplete } from './commands/index.js';
import { handleApprovalButton } from './interactions/approvalButtons.js';

import type { Repositories } from '../domain/repositories.js';
import { getGuardedResourcesForUser } from '../domain/policy.js';

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
    partials: [Partials.Channel, Partials.Message],
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

  // Message event listener for DMs
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      // Resolve partial message if necessary
      if (message.partial) {
        try {
          await message.fetch();
        } catch (err) {
          logger.warn('Failed to fetch partial DM message', {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      // Guard against missing author
      if (!message.author || message.author.bot) return;

      // Check if the message is in a DM channel (i.e. not in a guild)
      if (message.guildId !== null) return;

      // Guard against missing content
      if (!message.content) return;

      const content = message.content.trim().toLowerCase();

      // Route help command
      if (content === 'help' || content === '/help') {
        logger.info('Handling DM help request', { userId: message.author.id });
        await message.reply({
          content: [
            '🐾 **Purrmission Bot DM Help Guide**',
            '',
            'I am a security and approval gate bot. Here are the commands you can use:',
            '',
            '**Commands**:',
            '- `/check-dm-connectivity` (Slash Command): Test DM delivery settings.',
            '- `help` or `/help` (Text): Show this help message.',
            '- `status` or `/status` (Text): View your status, guarded resources, and pending requests waiting for your approval.',
            '',
            '**Approvals**:',
            'When an access request is created for a resource you guard, I will DM you the details along with buttons to **Approve** or **Deny**.',
          ].join('\n'),
        });
        return;
      }

      // Route status command
      if (content === 'status' || content === '/status') {
        logger.info('Handling DM status request', { userId: message.author.id });

        const userId = message.author.id;

        // Fetch resources guarded by this user
        const validResources = await getGuardedResourcesForUser(deps.repositories, userId);
        const resourceIds = validResources.map((r) => r.id);

        let guardedList = '_None. You are not registered as a guardian for any resources._';
        let pendingList = '_No pending approval requests waiting for you._';

        if (validResources.length > 0) {
          const maxDisplay = 15;
          const displayedResources = validResources.slice(0, maxDisplay);
          guardedList = displayedResources.map((r) => `- **${r.name}** (\`${r.id}\`)`).join('\n');
          if (validResources.length > maxDisplay) {
            guardedList += `\n_...and ${validResources.length - maxDisplay} more resources_`;
          }

          // Fetch pending approval requests for these resources
          const pendingRequestsNested = await Promise.all(
            resourceIds.map((resourceId) =>
              deps.repositories.approvalRequests.findPendingByResourceId(resourceId)
            )
          );

          // Filter out requests that have already expired in real-time
          const now = new Date();
          const pendingRequests = pendingRequestsNested
            .flat()
            .filter((req) => !req.expiresAt || req.expiresAt > now);

          if (pendingRequests.length > 0) {
            const displayedPending = pendingRequests.slice(0, maxDisplay);
            pendingList = displayedPending
              .map((req) => {
                const expiryText = req.expiresAt
                  ? `, Expires: <t:${Math.floor(req.expiresAt.getTime() / 1000)}:R>`
                  : '';
                return `- Request \`${req.id}\` for resource ID \`${req.resourceId}\` (Status: \`${req.status}\`${expiryText})`;
              })
              .join('\n');
            if (pendingRequests.length > maxDisplay) {
              pendingList += `\n_...and ${pendingRequests.length - maxDisplay} more pending requests_`;
            }
          }
        }

        await message.reply({
          content: [
            '🐾 **Purrmission Bot Status Report**',
            '',
            '**Your Guarded Resources**:',
            guardedList,
            '',
            '**Pending Approvals Waiting For You**:',
            pendingList,
            '',
            '_To approve or deny, use `/access approve <request-id>` or `/access deny <request-id>`._',
          ].join('\n'),
        });
        return;
      }
    } catch (error) {
      logger.error('Error handling DM message', {
        authorId: message.author?.id ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await message.reply({
          content: '❌ An error occurred while processing your message.',
        });
      } catch {
        // Ignore
      }
    }
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

    await handleApprovalButton(interaction, deps.services, deps.repositories, interaction.client);
    return;
  }

  // Ignore other button interactions
  logger.debug('Ignoring unknown button interaction', {
    customId: interaction.customId,
  });
}
