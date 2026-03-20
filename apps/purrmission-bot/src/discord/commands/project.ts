/**
 * Project member management handlers.
 *
 * These handlers are used by the /purrmission project subcommand group.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../../logging/logger.js';
import { ProjectMemberRole } from '../../domain/models.js';
import type { Services } from '../../domain/services.js';

/**
 * Handle adding a member to a project.
 */
export async function handleAddMember(
  interaction: ChatInputCommandInteraction,
  services: Services
) {
  await interaction.deferReply({ ephemeral: true });

  const projectId = interaction.options.getString('project_id', true);
  const targetUser = interaction.options.getUser('user', true);
  const roleInput = interaction.options.getString('role');
  const role: ProjectMemberRole = roleInput === 'WRITER' ? 'WRITER' : 'READER';
  const actorId = interaction.user.id;

  try {
    // Verify Project exists
    const project = await services.project.getProject(projectId);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    // Authorization: Only Owner can add members (for now)
    // TODO: Allow Guardians/Admins if needed
    if (project.ownerId !== actorId) {
      await interaction.editReply('❌ You must be the project owner to add members.');
      return;
    }

    // Add Member
    await services.project.addMember(projectId, targetUser.id, role, actorId);

    await interaction.editReply(
      `✅ Added <@${targetUser.id}> as a **${role}** to project **${project.name}**.`
    );
    logger.info('Added project member', { projectId, targetUserId: targetUser.id, role, actorId });
  } catch (error) {
    logger.error('Failed to add project member', { error });
    await interaction.editReply('❌ An error occurred while adding the member.');
  }
}

/**
 * Handle removing a member from a project.
 */
export async function handleRemoveMember(
  interaction: ChatInputCommandInteraction,
  services: Services
) {
  await interaction.deferReply({ ephemeral: true });

  const projectId = interaction.options.getString('project_id', true);
  const targetUser = interaction.options.getUser('user', true);
  const actorId = interaction.user.id;

  try {
    const project = await services.project.getProject(projectId);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    if (project.ownerId !== actorId) {
      await interaction.editReply('❌ You must be the project owner to remove members.');
      return;
    }

    await services.project.removeMember(projectId, targetUser.id);

    await interaction.editReply(`✅ Removed <@${targetUser.id}> from project **${project.name}**.`);
    logger.info('Removed project member', { projectId, targetUserId: targetUser.id, actorId });
  } catch (error) {
    logger.error('Failed to remove project member', { error });
    await interaction.editReply('❌ An error occurred while removing the member.');
  }
}

/**
 * Handle listing members of a project.
 */
export async function handleListMembers(
  interaction: ChatInputCommandInteraction,
  services: Services
) {
  await interaction.deferReply({ ephemeral: true });

  const projectId = interaction.options.getString('project_id', true);
  const actorId = interaction.user.id;

  try {
    const project = await services.project.getProject(projectId);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    // Auth check: Owner or Member can list
    const memberRole = await services.project.getMemberRole(projectId, actorId);
    if (project.ownerId !== actorId && !memberRole) {
      await interaction.editReply('❌ You do not have access to view members of this project.');
      return;
    }

    const members = await services.project.listMembers(projectId);

    if (members.length === 0) {
      await interaction.editReply(`Project **${project.name}** has no members.`);
      return;
    }

    const memberList = members
      .map((m: { userId: string; role: ProjectMemberRole }) => `- <@${m.userId}> (${m.role})`)
      .join('\n');

    await interaction.editReply({
      content: `**Members of ${project.name}:**\n${memberList}`,
      allowedMentions: { users: [] }, // Don't ping users
    });
  } catch (error) {
    logger.error('Failed to list project members', { error });
    await interaction.editReply('❌ An error occurred while listing members.');
  }
}
