/**
 * Handler for /purrmission-register-resource command.
 *
 * Creates a new protected resource and sets the caller as the owner.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';

/**
 * Handle the /purrmission-register-resource command.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
export async function handleRegisterResource(
  interaction: ChatInputCommandInteraction,
  services: Services
): Promise<void> {
  const name = interaction.options.getString('name', true);
  const userId = interaction.user.id;

  logger.info('Registering new resource', {
    name,
    ownerId: userId,
    guildId: interaction.guildId,
  });

  try {
    const { resource, guardian } = await services.resource.createResource(name, userId);

    await interaction.reply({
      content: [
        '✅ **Resource registered successfully!**',
        '',
        `**Name:** ${resource.name}`,
        `**ID:** \`${resource.id}\``,
        `**Mode:** ${resource.mode}`,
        '',
        '⚠️ **API Key (save this - it will only be shown once):**',
        `\`\`\`${resource.apiKey}\`\`\``,
        '',
        `You have been added as the **OWNER** (Guardian ID: \`${guardian.id}\`).`,
        '',
        'Use `/purrmission-add-guardian` to add more guardians.',
      ].join('\n'),
      ephemeral: true,
    });

    logger.info('Resource registered', { resourceId: resource.id, ownerId: userId });
  } catch (error) {
    logger.error('Failed to register resource', error);

    await interaction.reply({
      content: '❌ Failed to register resource. Please try again.',
      ephemeral: true,
    });
  }
}
