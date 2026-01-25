
import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { Command } from '../types/command.js';
import { logger } from '../../logging/logger.js';
import { ProjectMemberRole } from '../../domain/models.js';
import { Services } from '../../domain/services.js';

export const data = new SlashCommandBuilder()
    .setName('project')
    .setDescription('Manage project settings and members')
    .addSubcommandGroup(group =>
        group
            .setName('member')
            .setDescription('Manage project members')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('add')
                    .setDescription('Add a member to a project')
                    .addStringOption(option =>
                        option.setName('project_id').setDescription('The ID of the project').setRequired(true)
                    )
                    .addUserOption(option =>
                        option.setName('user').setDescription('The user to add').setRequired(true)
                    )
                    .addStringOption(option =>
                        option
                            .setName('role')
                            .setDescription('Access role (default: READER)')
                            .addChoices(
                                { name: 'Reader (Read-Only)', value: 'READER' },
                                { name: 'Writer (Read/Write)', value: 'WRITER' }
                            )
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('remove')
                    .setDescription('Remove a member from a project')
                    .addStringOption(option =>
                        option.setName('project_id').setDescription('The ID of the project').setRequired(true)
                    )
                    .addUserOption(option =>
                        option.setName('user').setDescription('The user to remove').setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('list')
                    .setDescription('List all members of a project')
                    .addStringOption(option =>
                        option.setName('project_id').setDescription('The ID of the project').setRequired(true)
                    )
            )
    );

export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === 'member') {
        if (subcommand === 'add') {
            await handleAddMember(interaction, services);
        } else if (subcommand === 'remove') {
            await handleRemoveMember(interaction, services);
        } else if (subcommand === 'list') {
            await handleListMembers(interaction, services);
        }
    }
}

async function handleAddMember(interaction: ChatInputCommandInteraction, services: Services) {
    await interaction.deferReply({ ephemeral: true });

    const projectId = interaction.options.getString('project_id', true);
    const targetUser = interaction.options.getUser('user', true);
    const role = (interaction.options.getString('role') as ProjectMemberRole) || 'READER';
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

async function handleRemoveMember(interaction: ChatInputCommandInteraction, services: Services) {
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

async function handleListMembers(interaction: ChatInputCommandInteraction, services: Services) {
    await interaction.deferReply({ ephemeral: true });

    const projectId = interaction.options.getString('project_id', true);
    const actorId = interaction.user.id;

    try {
        const project = await services.project.getProject(projectId);
        if (!project) {
            await interaction.editReply(`❌ Project not found: \`${projectId}\``);
            return;
        }

        // Auth check: Owner or Member can list?
        // Let's say Owner OR Member can list.
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
            allowedMentions: { users: [] } // Don't ping users
        });

    } catch (error) {
        logger.error('Failed to list project members', { error });
        await interaction.editReply('❌ An error occurred while listing members.');
    }
}

export default { data, execute } satisfies Command;
