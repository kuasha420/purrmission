/**
 * Handler for /purrmission-add-guardian command.
 *
 * Adds a new guardian to an existing protected resource.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../domain/services.js';
import { logger } from '../../logging/logger.js';

/**
 * Handle the /purrmission-add-guardian command.
 *
 * @param interaction - The command interaction
 * @param services - Application services
 */
export async function handleAddGuardian(
  interaction: ChatInputCommandInteraction,
  services: Services
): Promise<void> {
  const resourceId = interaction.options.getString('resource-id', true);
  const targetUser = interaction.options.getUser('user', true);
  const callerId = interaction.user.id;

  logger.info('Adding guardian to resource', {
    resourceId,
    targetUserId: targetUser.id,
    callerId,
  });

  // TODO: Verify that the caller is the OWNER of the resource
  // For MVP, we allow anyone to add guardians
  // In production, check:
  // const callerGuardian = await repositories.guardians.findByResourceAndUser(resourceId, callerId);
  // if (!callerGuardian || callerGuardian.role !== 'OWNER') {
  //   await interaction.reply({
  //     content: '❌ Only the resource owner can add guardians.',
  //     ephemeral: true,
  //   });
  //   return;
  // }

  try {
    const result = await services.resource.addGuardian(resourceId, targetUser.id);

    if (!result.success) {
      await interaction.reply({
        content: `❌ ${result.error}`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: [
        '✅ **Guardian added successfully!**',
        '',
        `**User:** <@${targetUser.id}>`,
        `**Resource ID:** \`${resourceId}\``,
        `**Guardian ID:** \`${result.guardian!.id}\``,
        `**Role:** ${result.guardian!.role}`,
      ].join('\n'),
      ephemeral: true,
    });

    logger.info('Guardian added successfully', {
      resourceId,
      guardianId: result.guardian!.id,
      targetUserId: targetUser.id,
    });
  } catch (error) {
    logger.error('Failed to add guardian', {
      resourceId,
      targetUserId: targetUser.id,
      error: error instanceof Error ? error.message : String(error),
    });

    await interaction.reply({
      content: '❌ Failed to add guardian. Please try again.',
      ephemeral: true,
    });
  }
}
