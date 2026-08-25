/**
 * Handler for /project command.
 *
 * Manages project settings and members.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandGroupBuilder,
} from 'discord.js';

import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';
import { ProjectMemberRole } from '../../domain/models.js';
import { createDiscordPrincipal } from '../../domain/principal.js';
import type { Services } from '../../domain/services.js';
import { ForbiddenError, NotFoundError } from '../../domain/ports.js';

export const projectCommand = new SlashCommandBuilder()
  .setName('project')
  .setDescription('Manage project settings and members')
  .addSubcommandGroup((group: SlashCommandSubcommandGroupBuilder) =>
    group
      .setName('member')
      .setDescription('Manage project members')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('add')
          .setDescription('Add a member to a project')
          .addStringOption((option) =>
            option.setName('project_id').setDescription('The ID of the project').setRequired(true)
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('The user to add').setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName('role')
              .setDescription('Access role (default: READER)')
              .addChoices(
                { name: 'Reader (Read-Only)', value: 'READER' },
                { name: 'Writer (Read/Write)', value: 'WRITER' }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('remove')
          .setDescription('Remove a member from a project')
          .addStringOption((option) =>
            option.setName('project_id').setDescription('The ID of the project').setRequired(true)
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('The user to remove').setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('list')
          .setDescription('List all members of a project')
          .addStringOption((option) =>
            option.setName('project_id').setDescription('The ID of the project').setRequired(true)
          )
      )
  );

/**
 * Handle /project subcommands.
 */
export async function handleProjectCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  switch (subcommandGroup) {
    case 'member':
      switch (subcommand) {
        case 'add':
          await handleAddMember(interaction, context.services);
          return;
        case 'remove':
          await handleRemoveMember(interaction, context.services);
          return;
        case 'list':
          await handleListMembers(interaction, context.services);
          return;
        default:
          await interaction.reply({
            content: `Unknown project member subcommand: ${subcommand}`,
            ephemeral: true,
          });
          return;
      }
    default:
      await interaction.reply({
        content: `Unknown subcommand group: ${subcommandGroup}`,
        ephemeral: true,
      });
  }
}

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
  const principal = createDiscordPrincipal(actorId, interaction.id);

  try {
    const project = await services.ports.getProject(principal, projectId, interaction.id);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    await services.ports.addProjectMember(
      principal,
      {
        projectId,
        memberUserId: targetUser.id,
        role,
      },
      interaction.id
    );

    await interaction.editReply(
      `✅ Added <@${targetUser.id}> as a **${role}** to project **${project.name}**.`
    );
    logger.info('Added project member', { projectId, targetUserId: targetUser.id, role, actorId });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await interaction.editReply('❌ You must be the project owner to add members.');
      return;
    }
    if (error instanceof NotFoundError) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }
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
  const principal = createDiscordPrincipal(actorId, interaction.id);

  try {
    const project = await services.ports.getProject(principal, projectId, interaction.id);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    await services.ports.removeProjectMember(principal, projectId, targetUser.id, interaction.id);

    await interaction.editReply(`✅ Removed <@${targetUser.id}> from project **${project.name}**.`);
    logger.info('Removed project member', { projectId, targetUserId: targetUser.id, actorId });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await interaction.editReply('❌ You must be the project owner to remove members.');
      return;
    }
    if (error instanceof NotFoundError) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }
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
  const principal = createDiscordPrincipal(actorId, interaction.id);

  try {
    const project = await services.ports.getProject(principal, projectId, interaction.id);
    if (!project) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }

    const members = await services.ports.listProjectMembers(principal, projectId, interaction.id);

    if (members.length === 0) {
      await interaction.editReply(`Project **${project.name}** has no members.`);
      return;
    }

    const memberList = members
      .map((m: { userId: string; role: ProjectMemberRole }) => `- <@${m.userId}> (${m.role})`)
      .join('\n');

    await interaction.editReply({
      content: `**Members of ${project.name}:**\n${memberList}`,
      allowedMentions: { users: [] },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await interaction.editReply('❌ You do not have access to view members of this project.');
      return;
    }
    if (error instanceof NotFoundError) {
      await interaction.editReply(`❌ Project not found: \`${projectId}\``);
      return;
    }
    logger.error('Failed to list project members', { error });
    await interaction.editReply('❌ An error occurred while listing members.');
  }
}
